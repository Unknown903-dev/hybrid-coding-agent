import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
import { approvalRecordSchema, integrationAuditSchema } from '../src/orchestration/integration-schemas.js';
import { runOrchestration } from '../src/orchestration/run-coordinator.js';
import { acquireExecutionLock, releaseExecutionLock } from '../src/proposal-execution.js';
import type { CodexSupervisorAdapter, SupervisorAdapterRequest, SupervisorAdapterResponse } from '../src/supervisor/codex-supervisor.js';
import type { TrustedCommand } from '../src/trusted-checks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const original = 'export function add(a: number, b: number) { return a - b; }\n';
const corrected = 'export function add(a: number, b: number) { return a + b; }\n';

class Supervisor implements CodexSupervisorAdapter {
  readonly requests: SupervisorAdapterRequest[] = [];
  private readonly responses: SupervisorAdapterResponse[];
  constructor(responses = [plan(), review()]) { this.responses = responses; }
  async run(request: SupervisorAdapterRequest): Promise<SupervisorAdapterResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('No mock response.');
    return response;
  }
}

class Proposal implements LocalProposalAdapter {
  readonly requests: LocalProposalRequest[] = [];
  async requestProposal(request: LocalProposalRequest): Promise<unknown> {
    this.requests.push(request);
    return {
      summary: 'Correct addition.', proposed_content: corrected,
      checks: ['Checks were not run by the model.'], risks: ['Human review required.'],
    };
  }
}

function plan(): SupervisorAdapterResponse {
  return { response: JSON.stringify({
    schema_version: '1.0', plan_id: '11111111-1111-4111-8111-111111111111',
    request: 'Fix calculator addition.', summary: 'One bounded correction.',
    context_status: 'sufficient', context_notes: 'calculator.ts is verified.',
    tasks: [{
      task_id: 'fix_calculator', title: 'Fix addition', description: 'Correct the existing addition implementation.',
      operation: 'modify_existing', file_scope: ['calculator.ts'], dependencies: [],
      acceptance_criteria: ['Addition returns the sum.', 'The export remains compatible.'],
      risk: 'low', complexity: 'simple', recommended_executor: 'local',
      routing_explanation: 'Bounded existing-file correction.', validation_requirements: ['Run calculator check.'],
      risk_tags: ['none'],
    }],
  }) };
}

function review(): SupervisorAdapterResponse {
  return { response: JSON.stringify({
    schema_version: '1.0', verdict: 'ready_for_human_review',
    findings: [{ severity: 'info', category: 'automated_checks', summary: 'Checks passed.', evidence: 'The report records a pass.' }],
    remaining_risks: ['Human semantic review remains required.'], proposed_next_action: 'Inspect and explicitly approve the patch.',
    semantic_correctness: 'plausible', human_approval_required: true,
  }) };
}

function check(): TrustedCommand {
  return {
    name: 'calculator', executable: process.execPath,
    args: ['-e', `const fs=require('fs');process.exit(fs.readFileSync('calculator.ts','utf8').includes('return a + b')?0:1)`],
    timeout_ms: 5_000, max_output_bytes: 10_000,
  };
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root })).stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'integration-'));
  temporaryDirectories.push(root);
  await git(root, ['init', '--quiet']);
  await writeFile(join(root, '.gitignore'), '.agent-runs/\n.agent-proposals/\n.agent-worktrees/\n.agent-state/\n');
  await writeFile(join(root, 'calculator.ts'), original);
  await writeFile(join(root, 'other.ts'), 'export const other = true;\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial']);
  return root;
}

async function completedRun(root: string): Promise<{ runId: string; reportPath: string }> {
  const result = await runOrchestration({
    project: root, request: 'Fix calculator addition.', apply: true, cloudAuthorized: true,
    localModel: 'mock-local', supervisorAdapter: new Supervisor(), proposalAdapter: new Proposal(),
    commands: [check()], maxRetries: 0,
  });
  expect(result.report.final_review.verdict).toBe('ready_for_human_review');
  return { runId: result.report.run_id, reportPath: result.reportPath };
}

async function approve(root: string, runId: string) {
  return approveOrchestrationRun({ project: root, runId, authorized: true, authorizationMethod: 'explicit_flag' });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('human approval and controlled integration', () => {
  it('inspects a completed run without changing source files', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    const before = await readFile(join(root, 'calculator.ts'), 'utf8');
    const inspection = await inspectOrchestrationRun(root, runId);
    expect(inspection.task).toContain('Fix calculator');
    expect(inspection.changedFiles).toEqual(['calculator.ts']);
    expect(inspection.patch).toContain('+export function add');
    expect(inspection.diffSummary.changedLines).toBe(2);
    expect(inspection.cloudReviewVerdict).toBe('ready_for_human_review');
    expect(inspection.warnings).toContain('Human semantic review remains required.');
    expect(inspection.eligibleForApproval).toBe(true);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(before);
  });

  it('records explicit hash-bound approval without modifying source', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    const result = await approve(root, runId);
    expect(approvalRecordSchema.parse(JSON.parse(await readFile(result.approvalPath, 'utf8'))).patch_sha256)
      .toBe(result.record.patch_sha256);
    expect(result.record.authorization_method).toBe('explicit_flag');
    expect(result.record.approved_files).toEqual(['calculator.ts']);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('integrates only the approved patch and creates no commit, merge, push, or deployment', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await approve(root, runId);
    const result = await integrateApprovedRun({ project: root, runId });
    expect(integrationAuditSchema.parse(JSON.parse(await readFile(result.auditPath, 'utf8'))).status).toBe('succeeded');
    expect(result.audit.changed_files).toEqual(['calculator.ts']);
    expect(result.audit.commit_created).toBe(false);
    expect(result.audit.push_performed).toBe(false);
    expect(result.audit.merge_performed).toBe(false);
    expect(result.audit.deployment_performed).toBe(false);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(corrected);
    expect(await readFile(join(root, 'other.ts'), 'utf8')).toBe('export const other = true;\n');
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['diff', '--name-only'])).toBe('calculator.ts\n');
  });

  it('rejects integration without an approval record', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow();
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
  });

  it('rejects a patch altered after approval', async () => {
    const root = await repository();
    const { runId, reportPath } = await completedRun(root);
    await approve(root, runId);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { final_patch_path: string };
    const patch = await readFile(report.final_patch_path, 'utf8');
    await writeFile(report.final_patch_path, `${patch}\n# altered\n`);
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/altered|Patch/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
  });

  it('rejects orchestration, execution, review, or approval record tampering', async () => {
    const root = await repository();
    const { runId, reportPath } = await completedRun(root);
    const approved = await approve(root, runId);
    const reportText = await readFile(reportPath, 'utf8');
    await writeFile(reportPath, `${reportText}\n`);
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/altered/i);
    await writeFile(reportPath, reportText);

    const approval = JSON.parse(await readFile(approved.approvalPath, 'utf8')) as Record<string, unknown>;
    approval.approved_at = new Date(0).toISOString();
    await writeFile(approved.approvalPath, JSON.stringify(approval));
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/signature|altered/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
  });

  it('detects execution and review artifact changes after approval', async () => {
    const executionRoot = await repository();
    const executionRun = await completedRun(executionRoot);
    await approve(executionRoot, executionRun.runId);
    const executionReport = JSON.parse(await readFile(executionRun.reportPath, 'utf8')) as { execution_report_path: string };
    const executionText = await readFile(executionReport.execution_report_path, 'utf8');
    await writeFile(executionReport.execution_report_path, `${executionText}\n`);
    await expect(integrateApprovedRun({ project: executionRoot, runId: executionRun.runId })).rejects.toThrow(/altered/i);

    const reviewRoot = await repository();
    const reviewRun = await completedRun(reviewRoot);
    await approve(reviewRoot, reviewRun.runId);
    const reviewReport = JSON.parse(await readFile(reviewRun.reportPath, 'utf8')) as { cloud_review_path: string };
    const reviewText = await readFile(reviewReport.cloud_review_path, 'utf8');
    await writeFile(reviewReport.cloud_review_path, `${reviewText}\n`);
    await expect(integrateApprovedRun({ project: reviewRoot, runId: reviewRun.runId })).rejects.toThrow(/altered/i);
  });

  it('rejects stale HEAD and stale source state', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await approve(root, runId);
    await writeFile(join(root, 'calculator.ts'), 'export const stale = true;\n');
    await git(root, ['add', 'calculator.ts']);
    await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'stale']);
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/HEAD|stale/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toContain('stale');
  });

  it('rejects a dirty tracked working tree', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await approve(root, runId);
    await writeFile(join(root, 'other.ts'), 'dirty\n');
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/tracked changes/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
  });

  it('rejects traversal scope and symlink escapes before approval', async () => {
    const traversalRoot = await repository();
    const traversalRun = await completedRun(traversalRoot);
    const report = JSON.parse(await readFile(traversalRun.reportPath, 'utf8')) as Record<string, any>;
    report.selected_task.file_scope = ['../escape.ts'];
    await writeFile(traversalRun.reportPath, JSON.stringify(report));
    await expect(inspectOrchestrationRun(traversalRoot, traversalRun.runId)).rejects.toThrow();

    const symlinkRoot = await repository();
    const symlinkRun = await completedRun(symlinkRoot);
    const outsideRoot = await mkdtemp(join(tmpdir(), 'integration-outside-'));
    temporaryDirectories.push(outsideRoot);
    const outside = join(outsideRoot, 'outside.ts');
    await writeFile(outside, original);
    await rm(join(symlinkRoot, 'calculator.ts'));
    await symlink(outside, join(symlinkRoot, 'calculator.ts'));
    await expect(inspectOrchestrationRun(symlinkRoot, symlinkRun.runId)).rejects.toThrow(/escape|symlink/i);
  });

  it('rejects unauthorized extra-file changes encoded in a patch', async () => {
    const root = await repository();
    const { runId, reportPath } = await completedRun(root);
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { final_patch_path: string };
    const patch = await readFile(report.final_patch_path, 'utf8');
    await writeFile(report.final_patch_path, `${patch}diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-export const other = true;\n+export const other = false;\n`);
    await expect(inspectOrchestrationRun(root, runId)).rejects.toThrow(/scope|authorized/i);
    expect(await readFile(join(root, 'other.ts'), 'utf8')).toBe('export const other = true;\n');
  });

  it('detects and rolls back unexpected files changed by the application step', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await approve(root, runId);
    const unsafeAdapter: PatchApplicationAdapter = {
      apply: async projectRoot => {
        await writeFile(join(projectRoot, 'calculator.ts'), corrected);
        await writeFile(join(projectRoot, 'other.ts'), 'export const other = false;\n');
      },
    };
    await expect(integrateApprovedRun({ project: root, runId, adapter: unsafeAdapter })).rejects.toThrow(/outside the approved scope/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
    expect(await readFile(join(root, 'other.ts'), 'utf8')).toBe('export const other = true;\n');
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('honors the same per-target concurrency lock as execution', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await approve(root, runId);
    const canonical = await realpath(root);
    const lock = await acquireExecutionLock(canonical, `${canonical}\0calculator.ts`, 'external');
    try {
      await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/Another execution/i);
      expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
    } finally {
      await releaseExecutionLock(lock);
    }
  });

  it('rolls back an interrupted patch application and records a failed audit', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await approve(root, runId);
    const interrupted: PatchApplicationAdapter = {
      apply: async projectRoot => {
        await writeFile(join(projectRoot, 'calculator.ts'), 'partial corruption\n');
        throw new Error('simulated interruption');
      },
    };
    await expect(integrateApprovedRun({ project: root, runId, adapter: interrupted })).rejects.toThrow('simulated interruption');
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const audits = await import('node:fs/promises').then(fs => fs.readdir(join(root, '.agent-state', 'integrations')));
    const audit = integrationAuditSchema.parse(JSON.parse(await readFile(join(root, '.agent-state', 'integrations', audits[0]!), 'utf8')));
    expect(audit.status).toBe('failed');
  });

  it('rejects repeated integration attempts', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await approve(root, runId);
    await integrateApprovedRun({ project: root, runId });
    await expect(integrateApprovedRun({ project: root, runId })).rejects.toThrow(/already integrated/i);
  });

  it('requires explicit approval authorization', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    await expect(approveOrchestrationRun({
      project: root, runId, authorized: false, authorizationMethod: 'interactive_confirmation',
    })).rejects.toThrow(/explicit/i);
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(original);
  });

  it('exposes inspect, approve, and integrate through the CLI', async () => {
    const root = await repository();
    const { runId } = await completedRun(root);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const invoke = (action: string, extra: string[] = []) => execFileAsync(process.execPath, [
      '--import', loader, cli, 'run', action, '--project', root, '--run-id', runId, ...extra,
    ], { cwd: root, env: { ...process.env, SUPERVISOR_CLOUD_ENABLED: '' } });
    expect((await invoke('inspect')).stdout).toContain('Eligible for approval: yes');
    expect((await invoke('approve', ['--yes'])).stdout).toContain('Approved exact patch');
    expect((await invoke('integrate')).stdout).toContain('No commit, push, merge, or deployment was performed');
    expect(await readFile(join(root, 'calculator.ts'), 'utf8')).toBe(corrected);
  });
});
