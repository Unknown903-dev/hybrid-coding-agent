import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { generateDiff, resolveSafeTargetPath, validateProposal, type DiffAnalysis, type ValidationReport } from './proposal-validation.js';
import { loadTrustedCommands, runTrustedCommand, type CheckResult, type TrustedCommand } from './trusted-checks.js';

export const EXECUTION_PROTECTED_PATHS = ['package.json', '.agent-validation.json', '.agent-runs', '.agent-worktrees'];

export interface ExecutionOptions {
  project: string;
  proposalPath: string;
  apply: boolean;
  keepWorktree?: boolean;
  commands?: TrustedCommand[];
}

export interface ExecutionReport {
  task_id: string;
  started_at: string;
  completed_at: string;
  status: 'passed' | 'failed';
  task?: string;
  model?: string;
  proposed_file?: string;
  proposal_summary?: string;
  proposal_path: string;
  worktree: {
    location?: string;
    preserved: boolean;
    cleaned: boolean;
  };
  diff_summary?: Pick<DiffAnalysis, 'addedLines' | 'removedLines' | 'changedLines' | 'changedRatio' | 'formattingOnly' | 'findings' | 'suspicious'>;
  structural_validation: {
    status: 'passed' | 'failed';
    errors: string[];
    warnings: string[];
  };
  application: {
    status: 'passed' | 'failed' | 'skipped';
    stale: boolean;
    error?: string;
  };
  checks: {
    status: 'passed' | 'failed' | 'skipped';
    results: CheckResult[];
  };
  human_review: {
    status: 'required';
    reasons: string[];
  };
  errors: string[];
  report_path?: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runProcess(executable: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise(resolveResult => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, { cwd, shell: false, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += String(chunk); });
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += String(chunk); });
    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      resolveResult({ code, stdout, stderr, ...(error ? { error } : {}) });
    };
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code));
  });
}

async function writeReport(projectRoot: string, report: ExecutionReport): Promise<string> {
  const runs = resolve(projectRoot, '.agent-runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const path = resolve(runs, `${report.task_id}.json`);
  const temporary = resolve(runs, `.${report.task_id}.${randomUUID()}.tmp`);
  report.report_path = path;
  await writeFile(temporary, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return path;
}

export async function acquireExecutionLock(projectRoot: string, key: string, taskId: string): Promise<{ handle: FileHandle; path: string }> {
  const locks = resolve(projectRoot, '.agent-runs', '.locks');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const path = resolve(locks, `${createHash('sha256').update(key).digest('hex')}.lock`);
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ task_id: taskId, pid: process.pid, created_at: new Date().toISOString() }));
    return { handle, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another execution for this proposal target is already running.');
    }
    throw error;
  }
}

export async function releaseExecutionLock(lock: { handle: FileHandle; path: string } | undefined): Promise<void> {
  if (!lock) return;
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.path).catch(() => undefined);
}

function baseReport(taskId: string, proposalPath: string, startedAt: string): ExecutionReport {
  return {
    task_id: taskId,
    started_at: startedAt,
    completed_at: startedAt,
    status: 'failed',
    proposal_path: proposalPath,
    worktree: { preserved: false, cleaned: false },
    structural_validation: { status: 'failed', errors: [], warnings: [] },
    application: { status: 'skipped', stale: false },
    checks: { status: 'skipped', results: [] },
    human_review: {
      status: 'required',
      reasons: ['Automated checks cannot establish semantic correctness or approval to merge.'],
    },
    errors: [],
  };
}

function copyValidation(report: ExecutionReport, validation: ValidationReport): void {
  report.structural_validation = {
    status: validation.valid ? 'passed' : 'failed',
    errors: [...validation.errors],
    warnings: [...validation.warnings],
  };
  if (validation.proposal) {
    report.task = validation.proposal.task;
    report.model = validation.proposal.model;
    report.proposed_file = validation.proposal.file;
    report.proposal_summary = validation.proposal.summary;
  }
  if (validation.diff) {
    const { unifiedDiff: _omitted, ...summary } = validation.diff;
    report.diff_summary = summary;
    if (validation.requiresManualReview) {
      for (const finding of validation.diff.findings) {
        if (!report.human_review.reasons.includes(finding)) report.human_review.reasons.push(finding);
      }
    }
  }
}

export async function executeProposal(options: ExecutionOptions): Promise<ExecutionReport> {
  const startedAt = new Date().toISOString();
  const taskId = randomUUID();
  const projectRoot = await realpath(options.project);
  const report = baseReport(taskId, resolve(projectRoot, options.proposalPath), startedAt);
  let lock: { handle: FileHandle; path: string } | undefined;
  let worktreeCreated = false;
  const worktreeRoot = resolve(projectRoot, '.agent-worktrees');
  const worktreePath = resolve(worktreeRoot, taskId);

  try {
    if (!options.apply) throw new Error('Execution requires explicit authorization with --apply.');

    let validation = await validateProposal({
      project: projectRoot,
      proposalPath: options.proposalPath,
      protectedPaths: EXECUTION_PROTECTED_PATHS,
    });
    copyValidation(report, validation);
    if (!validation.valid || !validation.proposal || !validation.diff || !validation.targetPath) {
      throw new Error(`Proposal validation failed: ${validation.errors.join('; ')}`);
    }
    if (!validation.proposal.original_sha256) {
      throw new Error('Proposal cannot be executed because it has no original_sha256; regenerate this legacy proposal.');
    }
    if (validation.originalSha256 !== validation.proposal.original_sha256) {
      report.application.stale = true;
      throw new Error('Proposal is stale: the original source file changed after proposal generation.');
    }

    lock = await acquireExecutionLock(projectRoot, `${projectRoot}\0${validation.proposal.file}`, taskId);
    const commands = options.commands ?? await loadTrustedCommands(projectRoot);

    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    const disabledHooks = resolve(projectRoot, '.agent-runs', '.disabled-hooks');
    await mkdir(disabledHooks, { recursive: true, mode: 0o700 });
    if (!isInside(worktreeRoot, worktreePath)) throw new Error('Refusing unsafe worktree location.');
    const added = await runProcess('git', ['-c', `core.hooksPath=${disabledHooks}`, 'worktree', 'add', '--detach', worktreePath, 'HEAD'], projectRoot);
    if (added.code !== 0) throw new Error(`Unable to create isolated Git worktree: ${added.error ?? added.stderr.trim()}`);
    worktreeCreated = true;
    report.worktree.location = worktreePath;

    // Revalidate the original immediately before the only source write.
    validation = await validateProposal({
      project: projectRoot,
      proposalPath: options.proposalPath,
      protectedPaths: EXECUTION_PROTECTED_PATHS,
    });
    copyValidation(report, validation);
    if (!validation.valid || !validation.proposal || !validation.targetPath || !validation.diff) {
      throw new Error(`Proposal revalidation failed: ${validation.errors.join('; ')}`);
    }
    if (!validation.proposal.original_sha256 || validation.originalSha256 !== validation.proposal.original_sha256) {
      report.application.stale = true;
      throw new Error('Proposal became stale before application; the source file was not written.');
    }

    const worktreeTarget = await resolveSafeTargetPath(worktreePath, validation.proposal.file, EXECUTION_PROTECTED_PATHS);
    const worktreeOriginal = await readFile(worktreeTarget.path, 'utf8');
    if (sha256(worktreeOriginal) !== validation.proposal.original_sha256) {
      report.application.stale = true;
      throw new Error('Proposal base does not match the checked-out HEAD in the isolated worktree.');
    }

    report.application = { status: 'failed', stale: false };
    await writeFile(worktreeTarget.path, validation.proposal.proposed_content, 'utf8');
    const appliedDiff = generateDiff(worktreeTarget.relativePath.split(sep).join('/'), worktreeOriginal, validation.proposal.proposed_content);
    if (appliedDiff.changedLines !== validation.diff.changedLines) {
      throw new Error('Applied diff did not match the revalidated proposal.');
    }
    report.application = { status: 'passed', stale: false };

    if (commands.length === 0) {
      report.checks.status = 'skipped';
      throw new Error('No trusted validation commands are configured; execution cannot report success.');
    }

    for (const command of commands) {
      const result = await runTrustedCommand(command, worktreePath);
      report.checks.results.push(result);
      if (result.status === 'failed') break;
    }
    report.checks.status = report.checks.results.length === commands.length && report.checks.results.every(result => result.status === 'passed')
      ? 'passed'
      : 'failed';
    if (report.checks.status !== 'passed') throw new Error('One or more trusted validation commands failed.');
    report.status = 'passed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.errors.push(message);
    if (report.application.status !== 'passed' && report.structural_validation.status === 'passed') {
      report.application.error = message;
    }
    if (report.application.status === 'passed' && report.checks.status === 'skipped') {
      report.checks.status = 'skipped';
    }
    report.status = 'failed';
  } finally {
    if (worktreeCreated && !options.keepWorktree) {
      const disabledHooks = resolve(projectRoot, '.agent-runs', '.disabled-hooks');
      const removed = await runProcess('git', ['-c', `core.hooksPath=${disabledHooks}`, 'worktree', 'remove', '--force', worktreePath], projectRoot);
      if (removed.code === 0) {
        report.worktree.cleaned = true;
      } else {
        report.errors.push(`Worktree cleanup failed: ${removed.error ?? removed.stderr.trim()}`);
        report.status = 'failed';
        report.worktree.preserved = true;
      }
    } else if (worktreeCreated) {
      report.worktree.preserved = true;
    }
    await releaseExecutionLock(lock);
    report.completed_at = new Date().toISOString();
    await writeReport(projectRoot, report);
  }

  return report;
}
