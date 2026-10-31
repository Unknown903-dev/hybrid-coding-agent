import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalProposalAdapter, LocalProposalRequest } from '../src/local-proposal.js';
import {
  approveOrchestrationRun,
  inspectOrchestrationRun,
  integrateApprovedRun,
  type PatchApplicationAdapter,
} from '../src/orchestration/integration.js';
import { integrationAuditSchema } from '../src/orchestration/integration-schemas.js';
import { runMultiTaskOrchestration, type MultiRunCoordinatorOptions } from '../src/orchestration/multi-run-coordinator.js';
import { acquireExecutionLock, releaseExecutionLock } from '../src/proposal-execution.js';
import type { RepairModelAdapter, RepairRequest } from '../src/repair-coordinator.js';
import type { CodexSupervisorAdapter, SupervisorAdapterRequest, SupervisorAdapterResponse } from '../src/supervisor/codex-supervisor.js';
import type { TrustedCommand } from '../src/trusted-checks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const calculatorOriginal = 'export function add(a: number, b: number) { return a - b; }\n';
const calculatorFixed = 'export function add(a: number, b: number) { return a + b; }\n';
const formatterOriginal = 'export const format = (value: string) => value.trim();\n';
const formatterFixed = 'export const format = (value: string) => value.trim().toUpperCase();\n';
const consumerOriginal = "import { format } from './formatter.js';\nexport const label = (value: string) => format(value);\n";
const consumerFixed = "import { format } from './formatter.js';\nexport const label = (value: string) => `[${format(value)}]`;\n";
const discountsCreated = 'export const discount = (value: number) => value * 0.9;\n';
const formatterWithDiscount = "import { discount } from './discounts.js';\nexport const formatPrice = (value: number) => String(discount(value));\n";

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
    const content = request.file === 'calculator.ts' ? calculatorFixed : request.file === 'formatter.ts' ? formatterFixed : consumerFixed;
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
  await writeFile(join(root, 'package.json'), '{"private":true}\n');
  await writeFile(join(root, 'calculator.ts'), calculatorOriginal);
  await writeFile(join(root, 'formatter.ts'), formatterOriginal);
  await writeFile(join(root, 'consumer.ts'), consumerOriginal);
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

function threeFileCheck(): TrustedCommand {
  return {
    name: 'three-file', executable: process.execPath,
    args: ['-e', `const fs=require('fs');const a=fs.readFileSync('calculator.ts','utf8');const b=fs.readFileSync('formatter.ts','utf8');const c=fs.readFileSync('consumer.ts','utf8');process.exit(a.includes('a + b')&&b.includes('toUpperCase')&&c.includes('format(value)}]')?0:1)`],
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

function mixedOptions(root: string): MultiRunCoordinatorOptions {
  const proposal: LocalProposalAdapter = { requestProposal: async request => ({
    summary: `Implement ${request.file}.`,
    proposed_content: request.file === 'discounts.ts' ? discountsCreated : formatterWithDiscount,
    checks: ['Not run by model.'], risks: ['Human review required.'],
  }) };
  const mixedCheck: TrustedCommand = {
    name: 'mixed', executable: process.execPath,
    args: ['-e', "const fs=require('fs');process.exit(fs.readFileSync('discounts.ts','utf8').includes('0.9')&&fs.readFileSync('formatter.ts','utf8').includes('./discounts.js')?0:1)"],
    timeout_ms: 5_000, max_output_bytes: 10_000,
  };
  return baseOptions(root, {
    supervisorAdapter: new QueueSupervisor([plan([
      task('update_formatter', 'formatter.ts', { dependencies: ['create_discounts'] }),
      task('create_discounts', 'discounts.ts', { operation: 'create' }),
    ]), review()]), proposalAdapter: proposal, commands: [mixedCheck],
  });
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

  it('executes a valid dependency chain and still rejects high-risk tasks', async () => {
    const dependencyRoot = await repository();
    const dependencyProposal = new MultiProposalAdapter();
    const dependency = await runMultiTaskOrchestration(baseOptions(dependencyRoot, {
      supervisorAdapter: new QueueSupervisor([plan([
        task('first', 'calculator.ts'), task('second', 'formatter.ts', { dependencies: ['first'] }),
      ]), review()]), proposalAdapter: dependencyProposal,
    }));
    expect(dependency.report.state).toBe('awaiting_human_review');
    expect(dependency.report.execution_order).toEqual(['first', 'second']);
    expect(dependency.report.task_results?.map(result => result.status)).toEqual(['passed', 'passed']);
    expect(dependency.report.task_results?.[1]?.dependencies).toEqual(['first']);
    expect(dependencyProposal.requests[1]?.task).toContain('Dependency task: first');
    expect(dependencyProposal.requests[1]?.task).toContain('return a + b');
    const dependencyInspection = await inspectOrchestrationRun(dependencyRoot, dependency.report.run_id);
    expect(dependencyInspection.eligibleForApproval).toBe(true);
    const dependencyApproval = await approveOrchestrationRun({
      project: dependencyRoot, runId: dependency.report.run_id, authorized: true, authorizationMethod: 'explicit_flag',
    });
    expect(dependencyApproval.record.approved_files).toEqual(['calculator.ts', 'formatter.ts']);

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

  it('topologically executes a three-task chain in one shared worktree', async () => {
    const root = await repository();
    const proposal = new MultiProposalAdapter();
    const result = await runMultiTaskOrchestration(baseOptions(root, {
      supervisorAdapter: new QueueSupervisor([plan([
        task('update_consumer', 'consumer.ts', { dependencies: ['update_formatter'] }),
        task('update_formatter', 'formatter.ts', { dependencies: ['fix_calculator'] }),
        task('fix_calculator', 'calculator.ts'),
      ]), review()]),
      proposalAdapter: proposal,
      commands: [threeFileCheck()],
    }));
    expect(result.report.execution_order).toEqual(['fix_calculator', 'update_formatter', 'update_consumer']);
    expect(proposal.requests.map(request => request.file)).toEqual(['calculator.ts', 'formatter.ts', 'consumer.ts']);
    expect(proposal.requests[2]?.task).toContain('Dependency task: update_formatter');
    expect(proposal.requests[2]?.task).toContain('toUpperCase');
    expect(proposal.requests[2]?.task).not.toContain('return a + b');
    expect(result.report.task_results?.every(taskResult => taskResult.status === 'passed')).toBe(true);
    expect(result.report.task_results?.every(taskResult => taskResult.source_sha256_before && taskResult.source_sha256_after)).toBe(true);
    expect(result.report.combined_checks?.status).toBe('passed');
    expect(await readFile(join(root, 'consumer.ts'), 'utf8')).toBe(consumerOriginal);
  });

  it('creates a new dependency, modifies its consumer, and integrates the exact mixed patch', async () => {
    const root = await repository();
    const head = await git(root, ['rev-parse', 'HEAD']);
    const result = await runMultiTaskOrchestration(mixedOptions(root));
    expect(result.report.execution_order).toEqual(['create_discounts', 'update_formatter']);
    expect(result.report.task_results?.map(item => item.operation)).toEqual(['create', 'modify']);
    expect(result.report.task_results?.[0]?.expected_absent_before).toBe(true);
    const patch = await readFile(result.report.final_patch_path!, 'utf8');
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('--- /dev/null');
    expect(patch).toContain('+++ b/discounts.ts');
    await expect(readFile(join(root, 'discounts.ts'))).rejects.toThrow();
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);

    const inspection = await inspectOrchestrationRun(root, result.report.run_id);
    expect(inspection.selectedTasks.map(item => item.operation)).toEqual(['create', 'modify']);
    expect(inspection.eligibleForApproval).toBe(true);
    const approved = await approveOrchestrationRun({
      project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag',
    });
    expect(approved.record.file_operations).toEqual({ 'formatter.ts': 'modify', 'discounts.ts': 'create' });
    expect(approved.record.expected_absent).toEqual(['discounts.ts']);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');

    const integrated = await integrateApprovedRun({ project: root, runId: result.report.run_id });
    expect(integrated.audit.status).toBe('succeeded');
    expect(integrated.audit.file_operations).toEqual(approved.record.file_operations);
    expect(await readFile(join(root, 'discounts.ts'), 'utf8')).toBe(discountsCreated);
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterWithDiscount);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['diff', '--name-only'])).toBe('formatter.ts\n');
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toContain('?? discounts.ts');
  });

  it('rejects a creation destination collision after approval', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(mixedOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    await writeFile(join(root, 'discounts.ts'), 'independent user content\n');
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id })).rejects.toThrow(/tracked changes|already exists|destination/i);
    expect(await readFile(join(root, 'discounts.ts'), 'utf8')).toBe('independent user content\n');
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
  });

  it('rejects tampered signed creation-operation metadata', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(mixedOptions(root));
    const approved = await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const record = JSON.parse(await readFile(approved.approvalPath, 'utf8')) as Record<string, any>;
    record.file_operations['discounts.ts'] = 'modify';
    await writeFile(approved.approvalPath, JSON.stringify(record));
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id })).rejects.toThrow(/signature|altered/i);
    await expect(readFile(join(root, 'discounts.ts'))).rejects.toThrow();
  });

  it('rolls back both a created file and an existing-file modification after post-application failure', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(mixedOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const wrongModification: PatchApplicationAdapter = { apply: async projectRoot => {
      await writeFile(join(projectRoot, 'formatter.ts'), 'wrong approved-file content\n');
    } };
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id, adapter: wrongModification })).rejects.toThrow(/exactly match/i);
    await expect(readFile(join(root, 'discounts.ts'))).rejects.toThrow();
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('preserves an independently changed creation collision and reports manual recovery', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(mixedOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const collision: PatchApplicationAdapter = { apply: async projectRoot => {
      await writeFile(join(projectRoot, 'formatter.ts'), formatterWithDiscount);
      await writeFile(join(projectRoot, 'discounts.ts'), 'external collision\n', { flag: 'wx' });
    } };
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id, adapter: collision })).rejects.toThrow(/Manual recovery required/i);
    expect(await readFile(join(root, 'discounts.ts'), 'utf8')).toBe('external collision\n');
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
  });

  it('rejects protected dependency context before contacting the local worker', async () => {
    const root = await repository();
    const proposal = new MultiProposalAdapter();
    const result = await runMultiTaskOrchestration(baseOptions(root, {
      supervisorAdapter: new QueueSupervisor([plan([
        task('protected_base', 'package.json'),
        task('consumer', 'formatter.ts', { dependencies: ['protected_base'] }),
      ])]),
      proposalAdapter: proposal,
    }));
    expect(result.report.state).toBe('blocked');
    expect(result.report.failure_reason).toMatch(/protected|unsafe/i);
    expect(proposal.requests).toHaveLength(0);
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
    const result = await runMultiTaskOrchestration(baseOptions(root, {
      supervisorAdapter: new QueueSupervisor([plan([
        task('first', 'calculator.ts'), task('second', 'formatter.ts', { dependencies: ['first'] }),
      ])]),
      taskCommands: [combinedCheck(false)],
    }));
    expect(result.report.state).toBe('failed');
    expect(result.report.task_results?.[0]?.automated_checks).toBe('failed');
    expect(result.report.task_results).toHaveLength(2);
    expect(result.report.task_results?.[1]?.status).toBe('blocked_by_dependency');
    expect(result.report.task_results?.[1]?.blocked_reason).toContain('first');
    expect(result.report.worktree?.preserved).toBe(true);
  });

  it('preserves the combined worktree and patch when final validation fails', async () => {
    const root = await repository();
    const supervisor = new QueueSupervisor([plan(), review('ready_for_human_review')]);
    const result = await runMultiTaskOrchestration(baseOptions(root, { commands: [combinedCheck(false)], supervisorAdapter: supervisor }));
    expect(result.report.combined_checks?.status).toBe('failed');
    expect(result.report.validation.automated_checks).toBe('failed');
    expect(result.report.state).toBe('failed');
    expect(result.report.worktree?.preserved).toBe(true);
    expect(result.report.final_patch_path).toBeTruthy();
    expect(result.report.final_review.verdict).toBe('retry_local');
    expect(supervisor.requests.map(request => request.operation)).toEqual(['plan', 'review']);
    const inspection = await inspectOrchestrationRun(root, result.report.run_id);
    expect(inspection.eligibleForApproval).toBe(false);
    expect(inspection.ineligibilityReasons.join(' ')).toMatch(/state|validation|checks/i);
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

  it('inspects and signs a complete multi-file approval without changing source', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    const inspection = await inspectOrchestrationRun(root, result.report.run_id);
    expect(inspection.changedFiles).toEqual(['calculator.ts', 'formatter.ts']);
    expect(inspection.selectedTasks.map(item => item.file)).toEqual(['calculator.ts', 'formatter.ts']);
    expect(inspection.executionOrder).toEqual(['fix_calculator', 'update_formatter']);
    expect(inspection.taskOutcomes).toHaveLength(2);
    expect(inspection.finalValidation?.status).toBe('passed');
    expect(inspection.patch).toContain('calculator.ts');
    expect(inspection.eligibleForApproval).toBe(true);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const cliOutput = (await execFileAsync(process.execPath, [
      '--import', loader, cli, 'run', 'inspect', '--project', root, '--run-id', result.report.run_id,
    ], { cwd: root, env: { ...process.env, SUPERVISOR_CLOUD_ENABLED: '' } })).stdout;
    expect(cliOutput).toContain('Selected tasks:');
    expect(cliOutput).toContain('Execution order: fix_calculator -> update_formatter');
    expect(cliOutput).toContain('Final combined validation: passed');
    const approved = await approveOrchestrationRun({
      project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag',
    });
    expect(approved.record.approved_files).toEqual(['calculator.ts', 'formatter.ts']);
    expect(Object.keys(approved.record.source_sha256).sort()).toEqual(approved.record.approved_files);
    expect(approved.record.validation_artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('transactionally integrates both approved files without creating Git history', async () => {
    const root = await repository();
    const head = await git(root, ['rev-parse', 'HEAD']);
    const result = await runMultiTaskOrchestration(baseOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const integrated = await integrateApprovedRun({ project: root, runId: result.report.run_id });
    expect(integrated.audit.status).toBe('succeeded');
    expect(integrated.audit.changed_files).toEqual(['calculator.ts', 'formatter.ts']);
    expect(integrated.audit.original_source_sha256 && Object.keys(integrated.audit.original_source_sha256).sort())
      .toEqual(['calculator.ts', 'formatter.ts']);
    expect(integrated.audit.resulting_source_sha256 && Object.keys(integrated.audit.resulting_source_sha256).sort())
      .toEqual(['calculator.ts', 'formatter.ts']);
    expect(integrated.audit.rollback).toEqual({ attempted: false, succeeded: true, manual_recovery_required: false, affected_paths: [] });
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorFixed);
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterFixed);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['diff', '--name-only'])).toBe('calculator.ts\nformatter.ts\n');
    expect(integrated.audit.commit_created || integrated.audit.push_performed || integrated.audit.merge_performed || integrated.audit.deployment_performed).toBe(false);
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id })).rejects.toThrow(/already integrated/i);
  });

  it('rejects stale or dirty state in either approved file before application', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    await writeFile(join(root, 'formatter.ts'), 'export const stale = true;\n');
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id })).rejects.toThrow(/tracked changes|stale/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
  });

  it('rolls back every approved file and an unexpected third-file change', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const unsafe: PatchApplicationAdapter = { apply: async projectRoot => {
      await writeFile(join(projectRoot, 'calculator.ts'), calculatorFixed);
      await writeFile(join(projectRoot, 'formatter.ts'), formatterFixed);
      await writeFile(join(projectRoot, '.gitignore'), 'unexpected\n');
    } };
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id, adapter: unsafe })).rejects.toThrow(/outside the approved scope/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.agent-runs/');
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('rolls back the first file when application fails while processing the second', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const interrupted: PatchApplicationAdapter = { apply: async projectRoot => {
      await writeFile(join(projectRoot, 'calculator.ts'), calculatorFixed);
      await writeFile(join(projectRoot, 'formatter.ts'), 'partial\n');
      throw new Error('second-file application failed');
    } };
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id, adapter: interrupted })).rejects.toThrow(/second-file/);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
    expect(await readFile(join(root, 'formatter.ts'), 'utf8')).toBe(formatterOriginal);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const names = await readdir(join(root, '.agent-state', 'integrations'));
    const audit = integrationAuditSchema.parse(JSON.parse(await readFile(join(root, '.agent-state', 'integrations', names[0]!), 'utf8')));
    expect(audit.rollback).toEqual({ attempted: true, succeeded: true, manual_recovery_required: false, affected_paths: ['calculator.ts', 'formatter.ts'] });
  });

  it('acquires overlapping locks deterministically and releases earlier locks after failure', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const canonical = await realpath(root);
    const formatterLock = await acquireExecutionLock(canonical, `${canonical}\0formatter.ts`, 'external');
    try {
      await expect(integrateApprovedRun({ project: root, runId: result.report.run_id })).rejects.toThrow(/Another execution/i);
      const calculatorLock = await acquireExecutionLock(canonical, `${canonical}\0calculator.ts`, 'probe');
      await releaseExecutionLock(calculatorLock);
    } finally {
      await releaseExecutionLock(formatterLock);
    }
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(calculatorOriginal);
  });

  it('records explicit manual-recovery state when complete rollback is impossible', async () => {
    const root = await repository();
    const result = await runMultiTaskOrchestration(baseOptions(root));
    await approveOrchestrationRun({ project: root, runId: result.report.run_id, authorized: true, authorizationMethod: 'explicit_flag' });
    const destructive: PatchApplicationAdapter = { apply: async projectRoot => {
      await writeFile(join(projectRoot, 'calculator.ts'), calculatorFixed);
      await rm(join(projectRoot, 'formatter.ts'));
      await mkdir(join(projectRoot, 'formatter.ts'));
      throw new Error('simulated filesystem failure');
    } };
    await expect(integrateApprovedRun({ project: root, runId: result.report.run_id, adapter: destructive })).rejects.toThrow(/Manual recovery required/i);
    const names = await readdir(join(root, '.agent-state', 'integrations'));
    const audit = integrationAuditSchema.parse(JSON.parse(await readFile(join(root, '.agent-state', 'integrations', names[0]!), 'utf8')));
    expect(audit.status).toBe('failed');
    expect(audit.rollback?.attempted).toBe(true);
    expect(audit.rollback?.succeeded).toBe(false);
    expect(audit.rollback?.manual_recovery_required).toBe(true);
  });
});
