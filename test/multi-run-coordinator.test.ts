import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalProposalAdapter, LocalProposalRequest } from '../src/local-proposal.js';
import { approveOrchestrationRun, inspectOrchestrationRun } from '../src/orchestration/integration.js';
import { runMultiTaskOrchestration, type MultiRunCoordinatorOptions } from '../src/orchestration/multi-run-coordinator.js';
import type { RepairModelAdapter, RepairRequest } from '../src/repair-coordinator.js';
import type { CodexSupervisorAdapter, SupervisorAdapterRequest, SupervisorAdapterResponse } from '../src/supervisor/codex-supervisor.js';
import type { TrustedCommand } from '../src/trusted-checks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const calculatorOriginal = 'export function add(a: number, b: number) { return a - b; }\n';
const calculatorFixed = 'export function add(a: number, b: number) { return a + b; }\n';
const formatterOriginal = 'export const format = (value: string) => value.trim();\n';
const formatterFixed = 'export const format = (value: string) => value.trim().toUpperCase();\n';

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

class MultiProposalAdapter implements LocalProposalAdapter {
  readonly requests: LocalProposalRequest[] = [];
  constructor(
    private readonly hook?: (request: LocalProposalRequest, index: number) => Promise<void>,
    private readonly failAt?: number,
  ) {}
  async requestProposal(request: LocalProposalRequest): Promise<unknown> {
    const index = this.requests.length;
    this.requests.push(request);
    await this.hook?.(request, index);
    if (this.failAt === index) throw new Error('mock local generation failure');
    const content = request.file === 'calculator.ts' ? calculatorFixed : formatterFixed;
    return { summary: `Update ${request.file}.`, proposed_content: content, checks: ['Not run by model.'], risks: ['Human review required.'] };
  }
}

class NoRepairAdapter implements RepairModelAdapter {
  readonly requests: RepairRequest[] = [];
  async requestRepair(request: RepairRequest): Promise<unknown> {
    this.requests.push(request);
    throw new Error('Repair was not expected.');
  }
}

class QueueRepairAdapter implements RepairModelAdapter {
  readonly requests: RepairRequest[] = [];
  constructor(private readonly responses: unknown[]) {}
  async requestRepair(request: RepairRequest): Promise<unknown> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('No repair response remains.');
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
  const root = await mkdtemp(join(tmpdir(), 'multi-run-'));
  temporaryDirectories.push(root);
  await git(root, ['init', '--quiet']);
  await writeFile(join(root, '.gitignore'), '.agent-runs/\n.agent-proposals/\n.agent-worktrees/\n.agent-state/\n');
  await writeFile(join(root, 'calculator.ts'), calculatorOriginal);
  await writeFile(join(root, 'formatter.ts'), formatterOriginal);
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial']);
  return root;
}

function task(id: string, file: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: id, title: `Update ${file}`, description: `Make the bounded requested correction in ${file}.`,
    operation: 'modify_existing', file_scope: [file], dependencies: [],
    acceptance_criteria: [`${file} has the requested behavior.`, 'The public interface remains compatible.'],
    risk: 'low', complexity: 'simple', recommended_executor: 'local',
    routing_explanation: 'Independent low-risk existing-file task.', validation_requirements: ['Run trusted validation.'],
    risk_tags: ['none'], ...overrides,
  };
}

function plan(tasks = [task('fix_calculator', 'calculator.ts'), task('update_formatter', 'formatter.ts')]): SupervisorAdapterResponse {
  return { response: JSON.stringify({
    schema_version: '1.0', plan_id: '11111111-1111-4111-8111-111111111111',
    request: 'Update two utilities.', summary: 'Two independent existing-file tasks.',
    context_status: 'sufficient', context_notes: 'Both files are verified.', tasks,
  }), usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5 } };
}

function review(verdict: 'ready_for_human_review' | 'cloud_escalation_recommended' = 'ready_for_human_review'): SupervisorAdapterResponse {
  return { response: JSON.stringify({
    schema_version: '1.0', verdict,
    findings: [{ severity: 'info', category: 'automated_checks', summary: 'Combined validation was reviewed.', evidence: 'The combined report contains trusted results.' }],
    remaining_risks: ['Human review remains required.'], proposed_next_action: 'Inspect the combined patch.',
    semantic_correctness: 'plausible', human_approval_required: true,
  }), usage: { input_tokens: 80, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 4 } };
}

function combinedCheck(pass = true): TrustedCommand {
  return {
    name: 'combined', executable: process.execPath,
    args: ['-e', pass
      ? `const fs=require('fs');const a=fs.readFileSync('calculator.ts','utf8');const b=fs.readFileSync('formatter.ts','utf8');process.exit(a.includes('a + b')&&b.includes('toUpperCase')?0:1)`
      : 'process.exit(1)'],
    timeout_ms: 5_000, max_output_bytes: 10_000,
  };
}

function sequentialTaskCheck(): TrustedCommand {
  return {
    name: 'sequential', executable: process.execPath,
    args: ['-e', `const fs=require('fs');const a=fs.readFileSync('calculator.ts','utf8');const b=fs.readFileSync('formatter.ts','utf8');const ok=a.includes('a + b')&&(b.includes('value.trim();')||b.includes('toUpperCase'));process.exit(ok?0:1)`],
    timeout_ms: 5_000, max_output_bytes: 10_000,
  };
}

function baseOptions(root: string, overrides: Partial<MultiRunCoordinatorOptions> = {}): MultiRunCoordinatorOptions {
  return {
    project: root, request: 'Update the calculator and formatter utilities.', apply: true, cloudAuthorized: true,
    localModel: 'mock-local', maxTasks: 3, maxRetries: 0,
    supervisorAdapter: new QueueSupervisor([plan(), review()]), proposalAdapter: new MultiProposalAdapter(),
    repairAdapter: new NoRepairAdapter(), commands: [combinedCheck()], ...overrides,
  };
}

describe('sequential multi-task orchestration', () => {
  it('executes two independent files sequentially in one shared worktree and produces one patch', async () => {
    const root = await repository();
    const head = await git(root, ['rev-parse', 'HEAD']);
    const supervisor = new QueueSupervisor([plan(), review()]);
    const proposal = new MultiProposalAdapter();
    const result = await runMultiTaskOrchestration(baseOptions(root, { supervisorAdapter: supervisor, proposalAdapter: proposal }));
    expect(result.report.mode).toBe('multi_task');
    expect(result.report.task_results).toHaveLength(2);
    expect(result.report.task_results?.every(item => item.status === 'passed')).toBe(true);
    expect(result.report.combined_checks?.status).toBe('passed');
    expect(result.report.final_review.verdict).toBe('ready_for_human_review');
    expect(result.report.cloud_usage.calls_started).toBe(2);
    expect(result.report.final_patch_sha256).toMatch(/^[a-f0-9]{64}$/);
    const patch = await readFile(result.report.final_patch_path!, 'utf8');
    expect([...patch.matchAll(/^diff --git /gm)]).toHaveLength(2);
    expect(patch).toContain('calculator.ts');
    expect(patch).toContain('formatter.ts');
    expect(proposal.requests.map(request => request.file)).toEqual(['calculator.ts', 'formatter.ts']);
    expect(supervisor.requests.map(request => request.operation)).toEqual(['plan', 'review']);
    expect(result.report.worktree?.cleaned).toBe(true);
    expect((await git(root, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('runs optional task-level checks against cumulative sequential worktree state', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root, { taskCommands: [sequentialTaskCheck()] }));
    expect(result.report.task_results?.map(item => item.automated_checks)).toEqual(['passed', 'passed']);
    const taskReports = result.report.task_results!.map(item => item.execution_report_path!);
    const locations = await Promise.all(taskReports.map(async path => JSON.parse(await readFile(path, 'utf8')).worktree.location));
    expect(new Set(locations).size).toBe(1);
  });

  it('uses bounded local repair for a failing scoped task check', async () => {
    const root = await repository();
    const proposal: LocalProposalAdapter = {
      requestProposal: async request => ({
        summary: `Update ${request.file}.`,
        proposed_content: request.file === 'calculator.ts'
          ? 'export function add(a: number, b: number) { return a * b; }\n'
          : formatterFixed,
        checks: ['Not run by model.'], risks: ['Human review required.'],
      }),
    };
    const repair = new QueueRepairAdapter([{
      summary: 'Repair calculator addition.', proposed_content: calculatorFixed,
      checks: ['Not run by model.'], risks: ['Human review required.'],
    }]);
    const result = await runMultiTaskOrchestration(baseOptions(root, {
      proposalAdapter: proposal, repairAdapter: repair, maxRetries: 1, taskCommands: [sequentialTaskCheck()],
    }));
    expect(result.report.task_results?.[0]?.repair_attempts).toBe(1);
    expect(result.report.task_results?.[0]?.status).toBe('passed');
    expect(repair.requests).toHaveLength(1);
    expect(result.report.combined_checks?.status).toBe('passed');
  });

  it('rejects overlapping file scopes without invoking Ollama', async () => {
    const root = await repository();
    const proposal = new MultiProposalAdapter();
    const result = await runMultiTaskOrchestration(baseOptions(root, {
      supervisorAdapter: new QueueSupervisor([plan([task('first', 'calculator.ts'), task('second', 'calculator.ts')])]),
      proposalAdapter: proposal,
    }));
    expect(result.report.state).toBe('blocked');
    expect(result.report.failure_reason).toContain('same file');
    expect(proposal.requests).toHaveLength(0);
  });

  it('rejects dependencies and high-risk tasks without partial execution', async () => {
    const dependencyRoot = await repository();
    const dependencyProposal = new MultiProposalAdapter();
    const dependency = await runMultiTaskOrchestration(baseOptions(dependencyRoot, {
      supervisorAdapter: new QueueSupervisor([plan([
        task('first', 'calculator.ts'), task('second', 'formatter.ts', { dependencies: ['first'] }),
      ])]), proposalAdapter: dependencyProposal,
    }));
    expect(dependency.report.state).toBe('blocked');
    expect(dependency.report.failure_reason).toContain('dependencies');
    expect(dependencyProposal.requests).toHaveLength(0);

    const riskRoot = await repository();
    const riskProposal = new MultiProposalAdapter();
    const risky = await runMultiTaskOrchestration(baseOptions(riskRoot, {
      supervisorAdapter: new QueueSupervisor([plan([
        task('first', 'calculator.ts', { title: 'Change authentication', risk: 'high', risk_tags: ['authentication'] }),
        task('second', 'formatter.ts'),
      ])]), proposalAdapter: riskProposal,
    }));
    expect(risky.report.state).toBe('blocked');
    expect(riskProposal.requests).toHaveLength(0);
  });

  it('rejects a stale proposal digest and preserves the shared worktree', async () => {
    const root = await repository();
    const proposal = new MultiProposalAdapter(async request => {
      if (request.file !== 'calculator.ts') return;
      const worktrees = await readdir(join(root, '.agent-worktrees'));
      await writeFile(join(root, '.agent-worktrees', worktrees[0]!, 'calculator.ts'), 'export const stale = true;\n');
    });
    const result = await runMultiTaskOrchestration(baseOptions(root, { proposalAdapter: proposal }));
    expect(result.report.state).toBe('failed');
    expect(result.report.failure_reason).toMatch(/stale|digest/i);
    expect(result.report.worktree?.preserved).toBe(true);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
  });

  it('records local generation errors without executing remaining tasks', async () => {
    const root = await repository();
    const proposal = new MultiProposalAdapter(undefined, 1);
    const result = await runMultiTaskOrchestration(baseOptions(root, { proposalAdapter: proposal }));
    expect(result.report.state).toBe('failed');
    expect(result.report.task_results).toHaveLength(2);
    expect(result.report.task_results?.[1]?.error).toContain('mock local generation failure');
    expect(proposal.requests).toHaveLength(2);
    expect(result.report.worktree?.preserved).toBe(true);
  });

  it('stops on failed task-level validation and preserves the worktree', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root, { taskCommands: [combinedCheck(false)] }));
    expect(result.report.state).toBe('failed');
    expect(result.report.task_results?.[0]?.automated_checks).toBe('failed');
    expect(result.report.task_results).toHaveLength(1);
    expect(result.report.worktree?.preserved).toBe(true);
  });

  it('preserves the combined worktree and patch when final validation fails', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan(), review('ready_for_human_review')]);
    const result = await runMultiTaskOrchestration(baseOptions(root, { commands: [combinedCheck(false)], supervisorAdapter: supervisor }));
    expect(result.report.combined_checks?.status).toBe('failed');
    expect(result.report.validation.automated_checks).toBe('failed');
    expect(result.report.worktree?.preserved).toBe(true);
    expect(result.report.final_patch_path).toBeTruthy();
    expect(result.report.final_review.verdict).toBe('retry_local');
    expect(supervisor.requests.map(request => request.operation)).toEqual(['plan', 'review']);
  });

  it('enforces the shared two-call budget and retains the combined patch when review is unavailable', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan(), review()]);
    const result = await runMultiTaskOrchestration(baseOptions(root, { maxCloudCalls: 1, supervisorAdapter: supervisor }));
    expect(result.report.final_review.status).toBe('unavailable');
    expect(result.report.state).toBe('awaiting_cloud_review');
    expect(result.report.cloud_usage.calls_started).toBe(1);
    expect(result.report.final_patch_path).toBeTruthy();
    expect(supervisor.requests).toHaveLength(1);
  });

  it('makes combined patches reviewable but not approvable in Milestone 6C.1', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    const inspection = await inspectOrchestrationRun(root, result.report.run_id);
    expect(inspection.changedFiles).toEqual(['calculator.ts', 'formatter.ts']);
    expect(inspection.patch).toContain('calculator.ts');
    expect(inspection.eligibleForApproval).toBe(false);
    expect(inspection.ineligibilityReasons.join(' ')).toContain('review-only');
    await expect(approveOrchestrationRun({
      project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag',
    })).rejects.toThrow(/not eligible/i);
  });
});
