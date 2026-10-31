import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { executeProposal } from '../src/proposal-execution.js';
import type { TrustedCommand } from '../src/trusted-checks.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const originalContent = 'export const answer = 41;\n';
const proposedContent = 'export const answer = 42;\n';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: root });
  return result.stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'proposal-execution-'));
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

async function proposal(root: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const value = {
    task: 'Correct the answer',
    file: 'src/example.ts',
    model: 'test-model',
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

function command(name: string, source: string, timeoutMs = 2_000): TrustedCommand {
  return {
    name,
    executable: process.execPath,
    args: ['-e', source],
    timeout_ms: timeoutMs,
    max_output_bytes: 20_000,
  };
}

async function doesNotExist(path: string): Promise<boolean> {
  return access(path).then(() => false, () => true);
}

describe('executeProposal', () => {
  it('supports the execute CLI with explicit apply authorization', async () => {
    const root = await repository();
    const path = await proposal(root);
    await writeFile(join(root, '.agent-validation.json'), JSON.stringify({
      commands: [{
        name: 'cli-check',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeout_ms: 2_000,
        max_output_bytes: 20_000,
      }],
    }));
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const tsxLoader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));

    const result = await execFileAsync(process.execPath, [
      '--import', tsxLoader, cli, 'execute', '--project', root, '--proposal', path, '--apply',
    ], { cwd: root });

    expect(result.stdout).toContain('Proposal summary: Updates the answer.');
    expect(result.stdout).toContain('EXECUTION PASSED');
    expect(result.stdout).toContain('Human review: required');
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });

  it('applies in a detached worktree, passes checks, writes a report, and cleans up', async () => {
    const root = await repository();
    const path = await proposal(root);
    const headBefore = await git(root, ['rev-parse', 'HEAD']);

    const report = await executeProposal({
      project: root,
      proposalPath: path,
      apply: true,
      commands: [command('content-check', "const fs=require('fs');process.exit(fs.readFileSync('src/example.ts','utf8').includes('42')?0:2)")],
    });

    expect(report.status).toBe('passed');
    expect(report.structural_validation.status).toBe('passed');
    expect(report.application.status).toBe('passed');
    expect(report.checks.status).toBe('passed');
    expect(report.human_review.status).toBe('required');
    expect(report.worktree.cleaned).toBe(true);
    expect(await doesNotExist(report.worktree.location!)).toBe(true);
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await git(root, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const branches = await git(root, ['branch', '--format=%(refname)']);
    expect(branches.trim().split('\n')).toHaveLength(1);

    const stored = JSON.parse(await readFile(report.report_path!, 'utf8')) as Record<string, unknown>;
    expect(stored.status).toBe('passed');
    expect(stored.task_id).toBe(report.task_id);
  });

  it('loads repository-owner validation configuration instead of proposal claims', async () => {
    const root = await repository();
    const path = await proposal(root, { checks: ['Run a model-chosen dangerous command.'] });
    await writeFile(join(root, '.agent-validation.json'), JSON.stringify({
      commands: [{
        name: 'owner-check',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('trusted config ran')"],
        timeout_ms: 2_000,
        max_output_bytes: 20_000,
      }],
    }));

    const report = await executeProposal({ project: root, proposalPath: path, apply: true });

    expect(report.status).toBe('passed');
    expect(report.checks.results).toHaveLength(1);
    expect(report.checks.results[0]?.name).toBe('owner-check');
    expect(report.checks.results[0]?.stdout).toBe('trusted config ran');
    expect(JSON.stringify(report.checks.results)).not.toContain('dangerous command');
  });

  it.skipIf(process.platform === 'win32')('disables repository Git hooks during worktree creation', async () => {
    const root = await repository();
    const path = await proposal(root);
    const marker = join(root, 'hook-ran');
    const hook = join(root, '.git', 'hooks', 'post-checkout');
    await writeFile(hook, `#!/bin/sh\nprintf hook-ran > "${marker}"\n`);
    await chmod(hook, 0o700);

    const report = await executeProposal({
      project: root,
      proposalPath: path,
      apply: true,
      commands: [command('pass', 'process.exit(0)')],
    });

    expect(report.status).toBe('passed');
    expect(await doesNotExist(marker)).toBe(true);
  });

  it('rejects a stale proposal before creating a worktree', async () => {
    const root = await repository();
    const path = await proposal(root);
    await writeFile(join(root, 'src', 'example.ts'), 'export const answer = 40;\n');

    const report = await executeProposal({
      project: root,
      proposalPath: path,
      apply: true,
      commands: [command('never', 'process.exit(0)')],
    });

    expect(report.status).toBe('failed');
    expect(report.application.stale).toBe(true);
    expect(report.errors.join(' ')).toContain('stale');
    expect(report.worktree.location).toBeUndefined();
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toContain('40');
  });

  it('rejects unauthorized proposal paths without applying', async () => {
    const root = await repository();
    const path = await proposal(root, { file: '../outside.ts' });

    const report = await executeProposal({
      project: root,
      proposalPath: path,
      apply: true,
      commands: [command('never', 'process.exit(0)')],
    });

    expect(report.status).toBe('failed');
    expect(report.structural_validation.status).toBe('failed');
    expect(report.errors.join(' ')).toContain('validation failed');
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });

  it('records validation command failures and cleans up by default', async () => {
    const root = await repository();
    const path = await proposal(root);

    const report = await executeProposal({
      project: root,
      proposalPath: path,
      apply: true,
      commands: [command('failing-check', "process.stderr.write('failed check');process.exit(3)")],
    });

    expect(report.status).toBe('failed');
    expect(report.application.status).toBe('passed');
    expect(report.checks.status).toBe('failed');
    expect(report.checks.results[0]?.exit_code).toBe(3);
    expect(report.checks.results[0]?.stderr).toContain('failed check');
    expect(report.worktree.cleaned).toBe(true);
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });

  it('enforces command timeouts and preserves the failed worktree when requested', async () => {
    const root = await repository();
    const path = await proposal(root);

    const report = await executeProposal({
      project: root,
      proposalPath: path,
      apply: true,
      keepWorktree: true,
      commands: [command('slow-check', 'setInterval(()=>{},1000)', 50)],
    });

    expect(report.status).toBe('failed');
    expect(report.checks.results[0]?.timed_out).toBe(true);
    expect(report.worktree.preserved).toBe(true);
    expect(await readFile(join(report.worktree.location!, 'src', 'example.ts'), 'utf8')).toBe(proposedContent);
    const worktrees = await git(root, ['worktree', 'list', '--porcelain']);
    expect(worktrees).toContain(report.worktree.location!);
  });

  it('enforces validation output limits', async () => {
    const root = await repository();
    const path = await proposal(root);
    const noisy = command('noisy-check', "process.stdout.write('x'.repeat(50000))");
    noisy.max_output_bytes = 1_000;

    const report = await executeProposal({ project: root, proposalPath: path, apply: true, commands: [noisy] });

    expect(report.status).toBe('failed');
    expect(report.checks.results[0]?.output_truncated).toBe(true);
    expect(Buffer.byteLength(report.checks.results[0]?.stdout ?? '')).toBeLessThanOrEqual(1_000);
    expect(report.worktree.cleaned).toBe(true);
  });

  it('prevents concurrent executions for the same target', async () => {
    const root = await repository();
    const path = await proposal(root);
    const slow = command('slow-success', 'setTimeout(()=>process.exit(0),250)', 2_000);

    const reports = await Promise.all([
      executeProposal({ project: root, proposalPath: path, apply: true, commands: [slow] }),
      executeProposal({ project: root, proposalPath: path, apply: true, commands: [slow] }),
    ]);

    expect(reports.filter(report => report.status === 'passed')).toHaveLength(1);
    const blocked = reports.find(report => report.errors.some(error => error.includes('already running')));
    expect(blocked).toBeDefined();
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(originalContent);
  });

  it('refuses execution without explicit apply authorization', async () => {
    const root = await repository();
    const path = await proposal(root);

    const report = await executeProposal({ project: root, proposalPath: path, apply: false, commands: [] });

    expect(report.status).toBe('failed');
    expect(report.errors.join(' ')).toContain('--apply');
    expect(report.worktree.location).toBeUndefined();
  });
});
