import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coordinateRepair,
  type RepairModelAdapter,
  type RepairRequest,
} from '../src/repair-coordinator.js';
import type { TrustedCommand } from '../src/trusted-checks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalContent = 'export const answer = 41;\n';

class QueueAdapter implements RepairModelAdapter {
  readonly requests: RepairRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async requestRepair(request: RepairRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error('No mock repair response remains.');
    return this.responses.shift();
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: root });
  return result.stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'repair-coordinator-'));
  temporaryDirectories.push(root);
  await git(root, ['init', '--quiet']);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'example.ts'), originalContent);
  await writeFile(join(root, '.gitignore'), '.agent-proposals/\n.agent-runs/\n.agent-worktrees/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'initial']);
  await mkdir(join(root, '.agent-proposals'));
  return root;
}

async function proposal(root: string, proposedContent: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const value = {
    task: 'Correct the answer',
    file: 'src/example.ts',
    model: 'mock-model',
    summary: 'Updates the answer.',
    proposed_content: proposedContent,
    checks: ['Not run by the model.'],
    risks: ['Behavior changes.'],
    original_sha256: createHash('sha256').update(originalContent).digest('hex'),
    ...overrides,
  };
  const path = join(root, '.agent-proposals', `${Math.random()}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}

function repairResponse(content: string): Record<string, unknown> {
  return {
    summary: 'Repairs the failing answer.',
    proposed_content: content,
    checks: ['Not run by the model.'],
    risks: ['Requires trusted validation.'],
  };
}

function command(name: string, source: string, timeoutMs = 2_000): TrustedCommand {
  return {
    name,
    executable: process.execPath,
    args: ['-e', source],
    timeout_ms: timeoutMs,
    max_output_bytes: 20_000,
  };
}

function answerCheck(extraError = ''): TrustedCommand {
  return command('answer-test', `const fs=require('fs');const ok=fs.readFileSync('src/example.ts','utf8').includes('42');if(!ok)process.stderr.write(${JSON.stringify(`expected answer 42 ${extraError}`)});process.exit(ok?0:2)`);
}

async function missing(path: string): Promise<boolean> {
  return access(path).then(() => false, () => true);
}

describe('coordinateRepair', () => {
  it('stops before checks when explicit apply authorization is absent', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 42;\n');

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: false, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('authorization_required');
    expect(report.attempts).toHaveLength(0);
    expect(report.worktree.location).toBeUndefined();
  });

  it('passes on the initial attempt without calling Ollama', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 42;\n');
    const adapter = new QueueAdapter([]);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('passed');
    expect(report.stop_reason).toBe('checks_passed');
    expect(report.repair_attempts_used).toBe(0);
    expect(report.attempts).toHaveLength(1);
    expect(adapter.requests).toHaveLength(0);
  });

  it('repairs a failed proposal and preserves a reviewable patch after cleanup', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    const adapter = new QueueAdapter([repairResponse('export const answer = 42;\n')]);
    const headBefore = await git(root, ['rev-parse', 'HEAD']);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, adapter, commands: [answerCheck('API_KEY=supersecret')] });

    expect(report.status).toBe('passed');
    expect(report.repair_attempts_used).toBe(1);
    expect(report.attempts.filter(attempt => attempt.checks_status === 'passed')).toHaveLength(1);
    expect(adapter.requests[0]?.diagnostics).toContain('API_KEY=[REDACTED]');
    expect(adapter.requests[0]?.diagnostics).not.toContain('supersecret');
    expect(report.final_patch_path).toBeDefined();
    expect(await readFile(report.final_patch_path!, 'utf8')).toContain('+export const answer = 42;');
    expect(JSON.parse(await readFile(report.report_path!, 'utf8')).status).toBe('passed');
    expect(report.worktree.cleaned).toBe(true);
    expect(await missing(report.worktree.location!)).toBe(true);
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('fails after exhausting the repair budget', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    const adapter = new QueueAdapter([repairResponse('export const answer = 39;\n')]);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, maxRetries: 1, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('retry_budget_exhausted');
    expect(report.repair_attempts_used).toBe(1);
    expect(report.cloud_escalation_recommended).toBe(true);
  });

  it('stops when the model repeats an identical proposal', async () => {
    const root = await repository();
    const failedContent = 'export const answer = 40;\n';
    const path = await proposal(root, failedContent);
    const adapter = new QueueAdapter([repairResponse(failedContent)]);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('identical_proposal');
    expect(report.attempts.at(-1)?.proposal_valid).toBe(false);
  });

  it('stops repeated ineffective formatting-only repairs', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer=40;\n');
    const adapter = new QueueAdapter([repairResponse('export  const  answer = 40;\n')]);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('repeated_ineffective_attempt');
  });

  it('records a malformed repair response without applying it', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    const adapter = new QueueAdapter(['not-json']);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, maxRetries: 1, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('malformed_repair_response');
    expect(report.attempts.at(-1)?.proposal_valid).toBe(false);
    expect(report.attempts.at(-1)?.model_response).toContain('not-json');
  });

  it('stops early after repeated malformed repair responses', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    const adapter = new QueueAdapter(['not-json', { summary: 'still missing required fields' }]);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, maxRetries: 2, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('repeated_malformed_response');
    expect(report.proposal_validity).toBe('failed');
    expect(adapter.requests).toHaveLength(2);
  });

  it('rejects a repair response that attempts to change the authorized file', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    const adapter = new QueueAdapter([{ ...repairResponse('malicious\n'), file: 'src/other.ts' }]);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, adapter, commands: [answerCheck()] });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('unauthorized_file_modification');
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });

  it('rejects stale original source content before creating a worktree', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    await writeFile(join(root, 'src', 'example.ts'), 'export const answer = 43;\n');

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, commands: [answerCheck()], adapter: new QueueAdapter([]) });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('stale_proposal');
    expect(report.worktree.location).toBeUndefined();
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toContain('43');
  });

  it('records trusted check timeouts and cleans its worktree', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');
    const slow = command('slow-test', 'setInterval(()=>{},1000)', 50);

    const report = await coordinateRepair({ project: root, proposalPath: path, apply: true, maxRetries: 0, commands: [slow], adapter: new QueueAdapter([]) });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('check_timeout');
    expect(report.attempts[0]?.checks[0]?.timed_out).toBe(true);
    expect(report.worktree.cleaned).toBe(true);
  });

  it('prevents concurrent repair tasks for the same target', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 42;\n');
    const slowPass = command('slow-pass', 'setTimeout(()=>process.exit(0),250)', 2_000);

    const reports = await Promise.all([
      coordinateRepair({ project: root, proposalPath: path, apply: true, commands: [slowPass], adapter: new QueueAdapter([]) }),
      coordinateRepair({ project: root, proposalPath: path, apply: true, commands: [slowPass], adapter: new QueueAdapter([]) }),
    ]);

    expect(reports.filter(report => report.status === 'passed')).toHaveLength(1);
    expect(reports.find(report => report.stop_reason === 'concurrent_execution')).toBeDefined();
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });

  it('preserves an owned failed worktree only when requested', async () => {
    const root = await repository();
    const path = await proposal(root, 'export const answer = 40;\n');

    const report = await coordinateRepair({
      project: root,
      proposalPath: path,
      apply: true,
      keepWorktree: true,
      maxRetries: 0,
      commands: [answerCheck()],
      adapter: new QueueAdapter([]),
    });

    expect(report.status).toBe('failed');
    expect(report.worktree.preserved).toBe(true);
    expect(await readFile(join(report.worktree.location!, 'src', 'example.ts'), 'utf8')).toContain('40');
    expect(await git(root, ['worktree', 'list', '--porcelain'])).toContain(report.worktree.location!);
  });

  it('runs the repair CLI end to end in a disposable repository', async () => {
    const root = await repository();
    await writeFile(join(root, '.agent-validation.json'), JSON.stringify({
      commands: [{
        name: 'answer-check',
        executable: process.execPath,
        args: ['-e', "const fs=require('fs');process.exit(fs.readFileSync('src/example.ts','utf8').includes('42')?0:2)"],
        timeout_ms: 2_000,
        max_output_bytes: 20_000,
      }],
    }));
    await git(root, ['add', '.agent-validation.json']);
    await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'validation config']);
    const path = await proposal(root, 'export const answer = 42;\n');
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const tsxLoader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));

    const result = await execFileAsync(process.execPath, [
      '--import', tsxLoader, cli, 'repair', '--project', root, '--proposal', path, '--apply', '--max-retries', '2',
    ], { cwd: root });

    expect(result.stdout).toContain('REPAIR PASSED');
    expect(result.stdout).toContain('Semantic review: required');
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });
});
