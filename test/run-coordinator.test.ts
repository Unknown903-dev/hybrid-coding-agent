import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { type LocalProposalAdapter, type LocalProposalRequest } from '../src/local-proposal.js';
import { runOrchestration, type RunCoordinatorOptions } from '../src/orchestration/run-coordinator.js';
import { approveOrchestrationRun, inspectOrchestrationRun, integrateApprovedRun } from '../src/orchestration/integration.js';
import { orchestrationReportSchema } from '../src/orchestration/schemas.js';
import { acquireExecutionLock, releaseExecutionLock } from '../src/proposal-execution.js';
import type { RepairModelAdapter, RepairRequest } from '../src/repair-coordinator.js';
import type {
  CodexSupervisorAdapter,
  SupervisorAdapterRequest,
  SupervisorAdapterResponse,
} from '../src/supervisor/codex-supervisor.js';
import type { TrustedCommand } from '../src/trusted-checks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

class QueueSupervisor implements CodexSupervisorAdapter {
  readonly requests: SupervisorAdapterRequest[] = [];
  constructor(private readonly responses: Array<SupervisorAdapterResponse | Error>) {}
  async run(request: SupervisorAdapterRequest): Promise<SupervisorAdapterResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('No mock supervisor response remains.');
    if (response instanceof Error) throw response;
    return response;
  }
}

class ProposalAdapter implements LocalProposalAdapter {
  readonly requests: LocalProposalRequest[] = [];
  constructor(private readonly content: string, private readonly beforeReturn?: () => Promise<void>) {}
  async requestProposal(request: LocalProposalRequest): Promise<unknown> {
    this.requests.push(request);
    await this.beforeReturn?.();
    return {
      summary: 'Correct the calculator implementation.',
      proposed_content: this.content,
      checks: ['Trusted checks were not run by the model.'],
      risks: ['Human review remains required.'],
    };
  }
}

class RepairAdapter implements RepairModelAdapter {
  readonly requests: RepairRequest[] = [];
  constructor(private readonly responses: unknown[]) {}
  async requestRepair(request: RepairRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No mock repair response remains.');
    return response;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root })).stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orchestration-'));
  temporaryDirectories.push(root);
  await git(root, ['init', '--quiet']);
  await writeFile(join(root, '.gitignore'), '.agent-runs/\n.agent-proposals/\n.agent-worktrees/\n');
  await writeFile(join(root, 'calculator.ts'), 'export function add(a: number, b: number) { return a - b; }\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial']);
  return root;
}

function planTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 'fix_calculator',
    title: 'Correct calculator addition',
    description: 'Correct the existing addition implementation without changing its public interface.',
    operation: 'modify_existing',
    file_scope: ['calculator.ts'],
    dependencies: [],
    acceptance_criteria: ['Addition returns the sum.', 'The exported function remains compatible.'],
    risk: 'low',
    complexity: 'simple',
    recommended_executor: 'local',
    routing_explanation: 'This is a bounded single-file correction.',
    validation_requirements: ['Run the trusted calculator check.'],
    risk_tags: ['none'],
    ...overrides,
  };
}

function plan(tasks: Record<string, unknown>[] = [planTask()]): SupervisorAdapterResponse {
  return {
    response: JSON.stringify({
      schema_version: '1.0',
      plan_id: '11111111-1111-4111-8111-111111111111',
      request: 'Fix calculator addition.',
      summary: 'Correct one existing calculator file.',
      context_status: 'sufficient',
      context_notes: 'The calculator file is present in the verified inventory.',
      tasks,
    }),
    usage: {
      input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0,
      output_tokens: 30, reasoning_output_tokens: 5,
    },
  };
}

function review(verdict: 'ready_for_human_review' | 'retry_local' | 'cloud_escalation_recommended' | 'rejected' = 'ready_for_human_review'): SupervisorAdapterResponse {
  return {
    response: JSON.stringify({
      schema_version: '1.0',
      verdict,
      findings: [{
        severity: 'info', category: 'automated_checks', summary: 'Trusted checks were recorded.',
        evidence: 'The bounded execution report records the check outcome.',
      }],
      remaining_risks: ['A human must confirm semantic intent.'],
      proposed_next_action: 'Inspect the patch before any merge.',
      semantic_correctness: 'plausible',
      human_approval_required: true,
    }),
    usage: {
      input_tokens: 80, cached_input_tokens: 5, cache_write_input_tokens: 0,
      output_tokens: 20, reasoning_output_tokens: 4,
    },
  };
}

function repairResponse(content: string): unknown {
  return {
    summary: 'Repair the addition implementation.',
    proposed_content: content,
    checks: ['Trusted checks were not run by the model.'],
    risks: ['Human review remains required.'],
  };
}

function calculatorCheck(): TrustedCommand {
  return {
    name: 'calculator',
    executable: process.execPath,
    args: ['-e', `const fs=require('fs');const value=fs.readFileSync('calculator.ts','utf8');process.exit(value.includes('return a + b')?0:1)`],
    timeout_ms: 5_000,
    max_output_bytes: 10_000,
  };
}

async function options(root: string, overrides: Partial<RunCoordinatorOptions> = {}): Promise<RunCoordinatorOptions> {
  return {
    project: root,
    request: 'Fix the calculator addition bug.',
    apply: true,
    cloudAuthorized: true,
    localModel: 'mock-local',
    commands: [calculatorCheck()],
    supervisorAdapter: new QueueSupervisor([plan(), review()]),
    proposalAdapter: new ProposalAdapter('export function add(a: number, b: number) { return a + b; }\n'),
    repairAdapter: new RepairAdapter([]),
    ...overrides,
  };
}

describe('end-to-end orchestration coordinator', () => {
  it('runs, approves, and integrates one authorized new-file task', async () => {
    const root = await repository();
    const created = 'export const helper = (value: number) => value * 2;\n';
    const createPlan = plan([planTask({
      task_id: 'create_helper', title: 'Create helper', description: 'Create one bounded helper source file.',
      operation: 'create', file_scope: ['helper.ts'], routing_explanation: 'A justified low-risk source file.',
      acceptance_criteria: ['The helper exports its function.'], validation_requirements: ['Run helper check.'],
    })]);
    const helperCheck: TrustedCommand = {
      name: 'helper', executable: process.execPath,
      args: ['-e', "const fs=require('fs');process.exit(fs.readFileSync('helper.ts','utf8').includes('value * 2')?0:1)"],
      timeout_ms: 5_000, max_output_bytes: 10_000,
    };
    const result = await runOrchestration(await options(root, {
      request: 'Create a helper source file.', commands: [helperCheck],
      supervisorAdapter: new QueueSupervisor([createPlan, review()]), proposalAdapter: new ProposalAdapter(created),
    }));
    expect(result.report.state).toBe('awaiting_human_review');
    expect(await readFile(result.report.final_patch_path!, 'utf8')).toContain('new file mode 100644');
    await expect(readFile(join(root, 'helper.ts'))).rejects.toThrow();
    expect((await inspectOrchestrationRun(root, result.report.run_id)).eligibleForApproval).toBe(true);
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    await integrateApprovedRun({ project: root, runId: result.report.run_id });
    expect(await readFile(join(root, 'helper.ts'), 'utf8')).toBe(created);
  });

  it('runs a successful single-task workflow and preserves the original repository', async () => {
    const root = await repository();
    const head = await git(root, ['rev-parse', 'HEAD']);
    const source = await readFile(join(root, 'calculator.ts'), 'utf8');
    const supervisor = new QueueSupervisor([plan(), review()]);
    const proposal = new ProposalAdapter('export function add(a: number, b: number) { return a + b; }\n');

    const result = await runOrchestration(await options(root, { supervisorAdapter: supervisor, proposalAdapter: proposal }));

    expect(result.report.state).toBe('awaiting_human_review');
    expect(result.report.validation).toEqual({ plan: 'passed', proposal: 'passed', automated_checks: 'passed' });
    expect(result.report.final_review).toEqual({ status: 'completed', verdict: 'ready_for_human_review' });
    expect(result.report.cloud_usage.calls_started).toBe(2);
    expect(result.report.cloud_usage.token_usage?.input_tokens).toBe(180);
    expect(result.report.final_patch_path && await readFile(result.report.final_patch_path, 'utf8')).toContain('+export function add');
    expect(orchestrationReportSchema.parse(JSON.parse(await readFile(result.reportPath, 'utf8'))).run_id).toBe(result.report.run_id);
    expect(supervisor.requests.map(request => request.operation)).toEqual(['plan', 'review']);
    expect(proposal.requests).toHaveLength(1);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(source);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect((await git(root, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
  });

  it('repairs an initial failed implementation in the same bounded lifecycle', async () => {
    const root = await repository();
    const repair = new RepairAdapter([repairResponse('export function add(a: number, b: number) { return a + b; }\n')]);
    const result = await runOrchestration(await options(root, {
      proposalAdapter: new ProposalAdapter('export function add(a: number, b: number) { return a * b; }\n'),
      repairAdapter: repair,
      maxRetries: 1,
    }));

    expect(result.report.validation.automated_checks).toBe('passed');
    expect(result.report.transitions.map(item => item.state)).toContain('repairing');
    expect(repair.requests).toHaveLength(1);
  });

  it('records exhausted repair attempts as failed checks without claiming completion', async () => {
    const root = await repository();
    const result = await runOrchestration(await options(root, {
      proposalAdapter: new ProposalAdapter('export function add(a: number, b: number) { return a * b; }\n'),
      repairAdapter: new RepairAdapter([repairResponse('export function add(a: number, b: number) { return a / b; }\n')]),
      supervisorAdapter: new QueueSupervisor([plan(), review('ready_for_human_review')]),
      maxRetries: 1,
    }));

    expect(result.report.validation.automated_checks).toBe('failed');
    expect(result.report.failure_reason).toContain('retry_budget_exhausted');
    expect(result.report.final_review.verdict).toBe('cloud_escalation_recommended');
  });

  it('rejects malformed cloud planning output before any local call', async () => {
    const root = await repository();
    const proposal = new ProposalAdapter('unused');
    const supervisor = new QueueSupervisor([{ response: '{"schema_version":"bad"}' }]);
    const result = await runOrchestration(await options(root, { supervisorAdapter: supervisor, proposalAdapter: proposal }));
    expect(result.report.state).toBe('failed');
    expect(result.report.validation.plan).toBe('failed');
    expect(proposal.requests).toHaveLength(0);
  });

  it('rejects hallucinated paths without rewriting them', async () => {
    const root = await repository();
    const proposal = new ProposalAdapter('unused');
    const result = await runOrchestration(await options(root, {
      supervisorAdapter: new QueueSupervisor([plan([planTask({ file_scope: ['calculator.py'] })])]),
      proposalAdapter: proposal,
    }));
    expect(result.report.state).toBe('failed');
    expect(result.report.failure_reason).toContain('verified repository inventory');
    expect(proposal.requests).toHaveLength(0);
  });

  it('blocks high-risk and multi-task workflows after planning', async () => {
    const highRoot = await repository();
    const highProposal = new ProposalAdapter('unused');
    const high = await runOrchestration(await options(highRoot, {
      supervisorAdapter: new QueueSupervisor([plan([planTask({
        title: 'Change authentication', risk: 'high', risk_tags: ['authentication'],
      })])]),
      proposalAdapter: highProposal,
    }));
    expect(high.report.state).toBe('blocked');
    expect(highProposal.requests).toHaveLength(0);

    const multiRoot = await repository();
    const multiProposal = new ProposalAdapter('unused');
    const multi = await runOrchestration(await options(multiRoot, {
      supervisorAdapter: new QueueSupervisor([plan([
        planTask({ task_id: 'first' }), planTask({ task_id: 'second' }),
      ])]),
      proposalAdapter: multiProposal,
    }));
    expect(multi.report.state).toBe('blocked');
    expect(multi.report.failure_reason).toContain('exactly one task');
    expect(multiProposal.requests).toHaveLength(0);
  });

  it('requires cloud and application authorization before model calls', async () => {
    const cloudRoot = await repository();
    const noCloudSupervisor = new QueueSupervisor([plan()]);
    const noCloud = await runOrchestration(await options(cloudRoot, {
      cloudAuthorized: false, supervisorAdapter: noCloudSupervisor,
    }));
    expect(noCloud.report.state).toBe('blocked');
    expect(noCloudSupervisor.requests).toHaveLength(0);

    const applyRoot = await repository();
    const noApplySupervisor = new QueueSupervisor([plan()]);
    const noApply = await runOrchestration(await options(applyRoot, {
      apply: false, supervisorAdapter: noApplySupervisor,
    }));
    expect(noApply.report.state).toBe('blocked');
    expect(noApplySupervisor.requests).toHaveLength(0);
  });

  it('supports planning-only dry runs without local or review calls', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan()]);
    const proposal = new ProposalAdapter('unused');
    const result = await runOrchestration(await options(root, {
      apply: false, dryRun: true, supervisorAdapter: supervisor, proposalAdapter: proposal,
    }));
    expect(result.report.state).toBe('awaiting_human_review');
    expect(result.report.dry_run).toBe(true);
    expect(supervisor.requests.map(request => request.operation)).toEqual(['plan']);
    expect(proposal.requests).toHaveLength(0);
  });

  it('uses deterministic local eligibility rather than a model executor preference', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan([planTask({ recommended_executor: 'cloud' })])]);
    const result = await runOrchestration(await options(root, {
      apply: false, dryRun: true, supervisorAdapter: supervisor,
    }));
    expect(result.report.state).toBe('awaiting_human_review');
    expect(result.report.selected_task?.file_scope).toEqual(['calculator.ts']);
  });

  it('enforces one shared cloud-call budget and retains a successful patch awaiting review', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan(), review()]);
    const result = await runOrchestration(await options(root, { supervisorAdapter: supervisor, maxCloudCalls: 1 }));
    expect(result.report.state).toBe('awaiting_cloud_review');
    expect(result.report.final_review.status).toBe('unavailable');
    expect(result.report.cloud_usage.calls_started).toBe(1);
    expect(result.report.final_patch_path && await readFile(result.report.final_patch_path, 'utf8')).toContain('return a + b');
    expect(supervisor.requests).toHaveLength(1);
  });

  it('retains artifacts when cloud review fails after successful local execution', async () => {
    const root = await repository();
    const result = await runOrchestration(await options(root, {
      supervisorAdapter: new QueueSupervisor([plan(), new Error('mock review unavailable')]),
    }));
    expect(result.report.state).toBe('awaiting_cloud_review');
    expect(result.report.validation.automated_checks).toBe('passed');
    expect(result.report.final_review.status).toBe('unavailable');
    expect(result.report.final_patch_path).toBeTruthy();
  });

  it('blocks before Ollama when trusted checks are missing', async () => {
    const root = await repository();
    const proposal = new ProposalAdapter('unused');
    const supervisor = new QueueSupervisor([plan()]);
    const result = await runOrchestration(await options(root, {
      commands: [], proposalAdapter: proposal, supervisorAdapter: supervisor,
    }));
    expect(result.report.state).toBe('blocked');
    expect(result.report.failure_reason).toContain('No trusted validation commands');
    expect(proposal.requests).toHaveLength(0);
    expect(supervisor.requests).toHaveLength(1);
  });

  it('rejects a stale source digest before creating an execution worktree', async () => {
    const root = await repository();
    const proposal = new ProposalAdapter(
      'export function add(a: number, b: number) { return a + b; }\n',
      async () => writeFile(join(root, 'calculator.ts'), 'export function add(a: number, b: number) { return 100; }\n'),
    );
    const supervisor = new QueueSupervisor([plan()]);
    const result = await runOrchestration(await options(root, { proposalAdapter: proposal, supervisorAdapter: supervisor }));
    expect(result.report.state).toBe('failed');
    expect(result.report.validation.proposal).toBe('failed');
    expect(supervisor.requests).toHaveLength(1);
    expect((await git(root, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
  });

  it('records missing HEAD and dirty tracked state before any model call', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orchestration-no-head-'));
    temporaryDirectories.push(empty);
    await git(empty, ['init', '--quiet']);
    const noHeadSupervisor = new QueueSupervisor([plan()]);
    const noHead = await runOrchestration({
      project: empty, request: 'Fix calculator.', apply: true, cloudAuthorized: true,
      supervisorAdapter: noHeadSupervisor,
    });
    expect(noHead.report.state).toBe('failed');
    expect(noHead.report.failure_reason).toContain('Git preflight failed');
    expect(noHeadSupervisor.requests).toHaveLength(0);

    const dirtyRoot = await repository();
    await writeFile(join(dirtyRoot, 'calculator.ts'), 'dirty\n');
    const dirtySupervisor = new QueueSupervisor([plan()]);
    const dirty = await runOrchestration(await options(dirtyRoot, { supervisorAdapter: dirtySupervisor }));
    expect(dirty.report.state).toBe('failed');
    expect(dirty.report.failure_reason).toContain('clean tracked state');
    expect(dirtySupervisor.requests).toHaveLength(0);
  });

  it('records malformed or unavailable local proposal generation without review calls', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan(), review()]);
    const malformed: LocalProposalAdapter = {
      requestProposal: async () => '{not-json',
    };
    const result = await runOrchestration(await options(root, {
      supervisorAdapter: supervisor, proposalAdapter: malformed,
    }));
    expect(result.report.state).toBe('failed');
    expect(result.report.validation.proposal).toBe('failed');
    expect(result.report.failure_reason).toContain('malformed proposal JSON');
    expect(supervisor.requests.map(request => request.operation)).toEqual(['plan']);
  });

  it('honors per-target concurrent execution protection', async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    const lock = await acquireExecutionLock(canonicalRoot, `${canonicalRoot}\0calculator.ts`, 'external-test');
    try {
      const result = await runOrchestration(await options(root));
      expect(result.report.state).toBe('failed');
      expect(result.report.failure_reason).toMatch(/concurrent|Another execution/i);
      expect(result.report.validation.automated_checks).not.toBe('passed');
    } finally {
      await releaseExecutionLock(lock);
    }
  });
});
