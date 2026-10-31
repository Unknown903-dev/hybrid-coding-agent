import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { proposalSchema } from './proposal-schema.js';
import {
  EXECUTION_PROTECTED_PATHS,
  acquireExecutionLock,
  releaseExecutionLock,
} from './proposal-execution.js';
import {
  generateDiff,
  resolveSafeTargetPath,
  validateProposal,
  type DiffAnalysis,
} from './proposal-validation.js';
import {
  loadTrustedCommands,
  runTrustedCommand,
  type CheckResult,
  type TrustedCommand,
} from './trusted-checks.js';

const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES = 5;
const DEFAULT_TOTAL_TIME_BUDGET_MS = 10 * 60_000;
const MAX_TOTAL_TIME_BUDGET_MS = 60 * 60_000;
const MAX_DIAGNOSTIC_CHARS = 12_000;
const MAX_SOURCE_CONTEXT_CHARS = 40_000;
const MAX_MODEL_RESPONSE_CHARS = 50_000;

const repairResponseSchema = proposalSchema
  .pick({ summary: true, proposed_content: true, checks: true, risks: true })
  .strict();

export interface RepairRequest {
  task: string;
  file: string;
  model: string;
  currentContent: string;
  diagnostics: string;
  repairAttempt: number;
  maxRepairAttempts: number;
  timeoutMs: number;
}

export interface RepairModelAdapter {
  requestRepair(request: RepairRequest): Promise<unknown>;
}

export class OllamaRepairAdapter implements RepairModelAdapter {
  async requestRepair(request: RepairRequest): Promise<unknown> {
    const endpoint = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const response = await fetch(new URL('/api/chat', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(Math.min(request.timeoutMs, 180_000)),
      body: JSON.stringify({
        model: request.model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'system',
            content: `Repair one authorized source file after trusted checks failed. Return exactly one JSON object with keys summary (non-empty string), proposed_content (complete file string), checks (array of non-empty strings), and risks (array of non-empty strings). Do not return file paths, commands, markdown, tool calls, or claims that checks passed. Change only what is needed to address the supplied diagnostics while preserving public interfaces unless the task requires otherwise.`,
          },
          {
            role: 'user',
            content: `Task: ${sanitizeText(request.task, 2_000)}\nAuthorized file: ${request.file}\nRepair attempt: ${request.repairAttempt}/${request.maxRepairAttempts}\nSanitized diagnostics:\n${sanitizeText(request.diagnostics)}\nCurrent authorized source:\n${sanitizeText(request.currentContent, MAX_SOURCE_CONTEXT_CHARS)}`,
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${sanitizeText(await response.text(), 500)}`);
    const data = await response.json() as { message?: { content?: string } };
    if (!data.message?.content) throw new Error('Ollama returned an empty repair response.');
    if (data.message.content.length > 250_000) throw new Error('Ollama repair response exceeded 250000 characters.');
    return data.message.content;
  }
}

export interface RepairAttemptReport {
  attempt: number;
  kind: 'initial' | 'repair';
  retry_count: number;
  proposal_valid: boolean;
  proposal_hash?: string;
  proposal_summary?: string;
  validation_errors: string[];
  checks_status: 'passed' | 'failed' | 'skipped';
  checks: CheckResult[];
  modified_files: string[];
  diff_summary?: Omit<DiffAnalysis, 'unifiedDiff'>;
  error_fingerprint?: string;
  model_response?: string;
  diagnostics_forwarded?: string;
  duration_ms: number;
}

export type RepairStopReason =
  | 'checks_passed'
  | 'authorization_required'
  | 'initial_validation_failed'
  | 'stale_proposal'
  | 'worktree_base_mismatch'
  | 'no_trusted_checks'
  | 'retry_budget_exhausted'
  | 'identical_proposal'
  | 'repeated_ineffective_attempt'
  | 'repair_validation_failed'
  | 'unauthorized_file_modification'
  | 'unexpected_source_change'
  | 'malformed_repair_response'
  | 'repeated_malformed_response'
  | 'time_budget_exceeded'
  | 'concurrent_execution'
  | 'check_timeout'
  | 'internal_error';

export interface RepairReport {
  task_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: 'passed' | 'failed';
  stop_reason: RepairStopReason;
  task?: string;
  model?: string;
  proposed_file?: string;
  proposal_path: string;
  max_repair_attempts: number;
  repair_attempts_used: number;
  worktree: { location?: string; preserved: boolean; cleaned: boolean };
  proposal_validity: 'passed' | 'failed';
  automated_checks: 'passed' | 'failed' | 'skipped';
  semantic_review: 'required';
  cloud_escalation_recommended: boolean;
  attempts: RepairAttemptReport[];
  final_patch_path?: string;
  report_path?: string;
  errors: string[];
}

export interface RepairCoordinatorOptions {
  project: string;
  proposalPath: string;
  apply: boolean;
  keepWorktree?: boolean;
  maxRetries?: number;
  totalTimeBudgetMs?: number;
  commands?: TrustedCommand[];
  adapter?: RepairModelAdapter;
  onRepairStart?: () => void | Promise<void>;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizedContent(content: string): string {
  return content.replace(/\s+/g, '');
}

export function sanitizeText(text: string, maxChars = MAX_DIAGNOSTIC_CHARS): string {
  const sanitized = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/[A-Fa-f0-9]{40,}/g, '[REDACTED_LONG_TOKEN]');
  if (sanitized.length <= maxChars) return sanitized;
  return `${sanitized.slice(0, maxChars)}\n[TRUNCATED]`;
}

function modelResponseForReport(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return sanitizeText(serialized ?? String(value), MAX_MODEL_RESPONSE_CHARS);
}

function sanitizedCheckResult(result: CheckResult): CheckResult {
  return {
    ...result,
    stdout: sanitizeText(result.stdout, 6_000),
    stderr: sanitizeText(result.stderr, 6_000),
    ...(result.error ? { error: sanitizeText(result.error, 1_000) } : {}),
  };
}

function fingerprint(results: CheckResult[]): string {
  const normalized = results
    .filter(result => result.status === 'failed')
    .map(result => `${result.name}|${result.exit_code}|${result.timed_out}|${sanitizeText(`${result.stdout}\n${result.stderr}`, 6_000)}`)
    .join('\n')
    .replace(/\/[^\s:]+/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/gi, '<duration>')
    .replace(/\s+/g, ' ')
    .trim();
  return hash(normalized);
}

function diagnosticsFor(attempt: RepairAttemptReport): string {
  const lines = [
    `Attempt: ${attempt.attempt}`,
    `Modified files: ${attempt.modified_files.join(', ') || '(none)'}`,
    `Diff: +${attempt.diff_summary?.addedLines ?? 0} -${attempt.diff_summary?.removedLines ?? 0}, ${attempt.diff_summary?.changedLines ?? 0} changed lines`,
  ];
  for (const check of attempt.checks.filter(item => item.status === 'failed')) {
    lines.push(
      `Check: ${check.name}`,
      `Exit code: ${check.exit_code ?? 'none'}`,
      `Timed out: ${check.timed_out}`,
      `stdout:\n${sanitizeText(check.stdout, 3_000)}`,
      `stderr:\n${sanitizeText(check.stderr, 3_000)}`,
    );
  }
  return sanitizeText(lines.join('\n'), MAX_DIAGNOSTIC_CHARS);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runProcess(executable: string, args: string[], cwd: string, maxOutput = 1_000_000): Promise<ProcessResult> {
  return new Promise(resolveResult => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, { cwd, shell: false, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.setEncoding('utf8').on('data', chunk => { if (stdout.length < maxOutput) stdout += String(chunk).slice(0, maxOutput - stdout.length); });
    child.stderr?.setEncoding('utf8').on('data', chunk => { if (stderr.length < maxOutput) stderr += String(chunk).slice(0, maxOutput - stderr.length); });
    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      resolveResult({ code, stdout, stderr, ...(error ? { error } : {}) });
    };
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code));
  });
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseModifiedFiles(status: string): string[] {
  const entries = status.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const path = entry.slice(3).replaceAll('\\', '/');
    paths.push(path);
    if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C' || entry[1] === 'C') index += 1;
  }
  return [...new Set(paths)].sort();
}

async function modifiedFiles(worktree: string): Promise<string[]> {
  const result = await runProcess('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
  if (result.code !== 0) throw new Error(`Unable to inspect repair worktree: ${result.error ?? result.stderr}`);
  return parseModifiedFiles(result.stdout);
}

async function writeJsonArtifact(projectRoot: string, taskId: string, report: RepairReport): Promise<string> {
  const runs = resolve(projectRoot, '.agent-runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const path = resolve(runs, `${taskId}-repair.json`);
  const temporary = resolve(runs, `.${taskId}.${randomUUID()}.tmp`);
  report.report_path = path;
  await writeFile(temporary, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return path;
}

async function savePatch(projectRoot: string, worktree: string, taskId: string, file: string): Promise<string | undefined> {
  const result = await runProcess('git', ['diff', '--no-ext-diff', '--binary', '--', file], worktree, 2_000_000);
  if (result.code !== 0) throw new Error(`Unable to generate final repair patch: ${result.error ?? result.stderr}`);
  if (!result.stdout) return undefined;
  const path = resolve(projectRoot, '.agent-runs', `${taskId}.patch`);
  await mkdir(resolve(projectRoot, '.agent-runs'), { recursive: true, mode: 0o700 });
  await writeFile(path, result.stdout, { flag: 'wx', mode: 0o600 });
  return path;
}

async function requestWithDeadline(adapter: RepairModelAdapter, request: RepairRequest, timeoutMs: number): Promise<unknown> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      adapter.requestRepair(request),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Repair model request exceeded the remaining time budget.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseRepairResponse(raw: unknown): { success: true; data: typeof repairResponseSchema._output } | { success: false; errors: string[]; unauthorizedFile: boolean } {
  if (typeof raw === 'string' && raw.length > 250_000) {
    return { success: false, errors: ['Repair response exceeds 250000 characters.'], unauthorizedFile: false };
  }
  let value = raw;
  try {
    if (typeof raw === 'string') value = JSON.parse(raw);
  } catch (error) {
    return { success: false, errors: [`Malformed JSON: ${error instanceof Error ? error.message : String(error)}`], unauthorizedFile: false };
  }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const unauthorizedFile = record !== undefined && 'file' in record;
  const parsed = repairResponseSchema.safeParse(value);
  if (!parsed.success) {
    return { success: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'response'}: ${issue.message}`), unauthorizedFile };
  }
  return { success: true, data: parsed.data };
}

function initialReport(taskId: string, proposalPath: string, startedAt: string, maxRetries: number): RepairReport {
  return {
    task_id: taskId,
    started_at: startedAt,
    completed_at: startedAt,
    duration_ms: 0,
    status: 'failed',
    stop_reason: 'internal_error',
    proposal_path: proposalPath,
    max_repair_attempts: maxRetries,
    repair_attempts_used: 0,
    worktree: { preserved: false, cleaned: false },
    proposal_validity: 'failed',
    automated_checks: 'skipped',
    semantic_review: 'required',
    cloud_escalation_recommended: true,
    attempts: [],
    errors: [],
  };
}

export async function coordinateRepair(options: RepairCoordinatorOptions): Promise<RepairReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const taskId = randomUUID();
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES) {
    throw new Error(`maxRetries must be an integer between 0 and ${MAX_RETRIES}.`);
  }
  const totalBudget = options.totalTimeBudgetMs ?? DEFAULT_TOTAL_TIME_BUDGET_MS;
  if (!Number.isFinite(totalBudget) || totalBudget <= 0 || totalBudget > MAX_TOTAL_TIME_BUDGET_MS) {
    throw new Error(`totalTimeBudgetMs must be between 1 and ${MAX_TOTAL_TIME_BUDGET_MS}.`);
  }
  const projectRoot = await realpath(options.project);
  const report = initialReport(taskId, resolve(projectRoot, options.proposalPath), startedAt, maxRetries);
  const worktreeRoot = resolve(projectRoot, '.agent-worktrees');
  const worktreePath = resolve(worktreeRoot, taskId);
  const disabledHooks = resolve(projectRoot, '.agent-runs', '.disabled-hooks');
  let lock: { handle: FileHandle; path: string } | undefined;
  let worktreeCreated = false;
  let authorizedFile = '';

  const remainingTime = (): number => totalBudget - (Date.now() - started);
  const fail = (reason: RepairStopReason, message: string): never => {
    report.stop_reason = reason;
    report.errors.push(message);
    throw new Error(message);
  };

  try {
    if (!options.apply) fail('authorization_required', 'Repair requires explicit authorization with --apply.');

    let validation = await validateProposal({
      project: projectRoot,
      proposalPath: options.proposalPath,
      protectedPaths: EXECUTION_PROTECTED_PATHS,
    });
    if (!validation.valid || !validation.proposal || !validation.diff || !validation.targetPath) {
      fail('initial_validation_failed', `Initial proposal validation failed: ${validation.errors.join('; ')}`);
    }
    const initialProposal = validation.proposal!;
    report.proposal_validity = 'passed';
    report.task = initialProposal.task;
    report.model = initialProposal.model;
    report.proposed_file = initialProposal.file;
    authorizedFile = initialProposal.file;
    if (!initialProposal.original_sha256 || validation.originalSha256 !== initialProposal.original_sha256) {
      fail('stale_proposal', 'Initial proposal is stale or lacks the required original_sha256.');
    }

    try {
      lock = await acquireExecutionLock(projectRoot, `${projectRoot}\0${authorizedFile}`, taskId);
    } catch (error) {
      fail('concurrent_execution', error instanceof Error ? error.message : String(error));
    }
    const commands = options.commands ?? await loadTrustedCommands(projectRoot);
    if (commands.length === 0) fail('no_trusted_checks', 'No trusted validation commands are configured.');

    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
    await mkdir(disabledHooks, { recursive: true, mode: 0o700 });
    if (!isInside(worktreeRoot, worktreePath)) fail('internal_error', 'Refusing unsafe repair worktree location.');
    const added = await runProcess('git', ['-c', `core.hooksPath=${disabledHooks}`, 'worktree', 'add', '--detach', worktreePath, 'HEAD'], projectRoot);
    if (added.code !== 0) fail('internal_error', `Unable to create repair worktree: ${added.error ?? added.stderr}`);
    worktreeCreated = true;
    report.worktree.location = worktreePath;

    validation = await validateProposal({ project: projectRoot, proposalPath: options.proposalPath, protectedPaths: EXECUTION_PROTECTED_PATHS });
    if (!validation.valid || !validation.proposal || !validation.diff || !validation.proposal.original_sha256 || validation.originalSha256 !== validation.proposal.original_sha256) {
      fail('stale_proposal', 'Initial proposal became stale before worktree application.');
    }
    const revalidatedProposal = validation.proposal!;
    const revalidatedDiff = validation.diff!;
    const target = await resolveSafeTargetPath(worktreePath, authorizedFile, EXECUTION_PROTECTED_PATHS);
    const original = await readFile(target.path, 'utf8');
    if (hash(original) !== revalidatedProposal.original_sha256) fail('worktree_base_mismatch', 'Proposal source does not match the worktree HEAD.');

    const proposalHashes = new Set<string>();
    let expectedCurrentHash = hash(original);
    let currentProposal = revalidatedProposal;
    let currentDiff = revalidatedDiff;
    let retryCount = 0;
    let malformedCount = 0;
    let previousFingerprint: string | undefined;
    let previousNormalizedContent: string | undefined;
    let pendingModelResponse: string | undefined;
    const adapter = options.adapter ?? new OllamaRepairAdapter();

    while (true) {
      if (remainingTime() <= 0) fail('time_budget_exceeded', 'Repair exceeded its total time budget.');
      const attemptStarted = Date.now();
      const currentOnDisk = await readFile(target.path, 'utf8');
      if (hash(currentOnDisk) !== expectedCurrentHash) fail('unexpected_source_change', 'Authorized source changed unexpectedly before proposal application.');

      const proposalHash = hash(currentProposal.proposed_content);
      if (proposalHashes.has(proposalHash)) fail('identical_proposal', 'The local worker repeated an identical proposal.');
      proposalHashes.add(proposalHash);
      await writeFile(target.path, currentProposal.proposed_content, 'utf8');
      expectedCurrentHash = proposalHash;

      const beforeChecksFiles = await modifiedFiles(worktreePath);
      if (beforeChecksFiles.some(file => file !== authorizedFile.replaceAll('\\', '/'))) {
        fail('unauthorized_file_modification', 'Proposal application modified a file outside the authorized target.');
      }

      const checks: CheckResult[] = [];
      for (const command of commands) {
        if (remainingTime() <= 0) fail('time_budget_exceeded', 'Repair exceeded its total time budget while running checks.');
        const boundedCommand = { ...command, timeout_ms: Math.min(command.timeout_ms, Math.max(remainingTime(), 1)) };
        const result = sanitizedCheckResult(await runTrustedCommand(boundedCommand, worktreePath));
        checks.push(result);
        if (result.status === 'failed') break;
      }
      const files = await modifiedFiles(worktreePath);
      const afterChecksContent = await readFile(target.path, 'utf8');
      if (hash(afterChecksContent) !== expectedCurrentHash) fail('unexpected_source_change', 'A trusted check changed the authorized source unexpectedly.');
      if (files.some(file => file !== authorizedFile.replaceAll('\\', '/'))) {
        fail('unauthorized_file_modification', `Trusted checks modified unauthorized files: ${files.filter(file => file !== authorizedFile.replaceAll('\\', '/')).join(', ')}`);
      }

      const checksPassed = checks.length === commands.length && checks.every(check => check.status === 'passed');
      const attempt: RepairAttemptReport = {
        attempt: report.attempts.length + 1,
        kind: retryCount === 0 ? 'initial' : 'repair',
        retry_count: retryCount,
        proposal_valid: true,
        proposal_hash: proposalHash,
        proposal_summary: currentProposal.summary,
        validation_errors: [],
        checks_status: checksPassed ? 'passed' : 'failed',
        checks,
        modified_files: files,
        diff_summary: (({ unifiedDiff: _omitted, ...summary }) => summary)(currentDiff),
        ...(pendingModelResponse ? { model_response: pendingModelResponse } : {}),
        duration_ms: Date.now() - attemptStarted,
      };
      pendingModelResponse = undefined;
      if (!checksPassed) attempt.error_fingerprint = fingerprint(checks);
      report.attempts.push(attempt);

      if (checksPassed) {
        report.status = 'passed';
        report.stop_reason = 'checks_passed';
        report.automated_checks = 'passed';
        report.cloud_escalation_recommended = false;
        break;
      }
      report.automated_checks = 'failed';
      if (checks.some(check => check.timed_out) && retryCount >= maxRetries) {
        fail('check_timeout', 'A trusted validation command timed out and no repair attempts remain.');
      }
      if (previousFingerprint === attempt.error_fingerprint && previousNormalizedContent === normalizedContent(currentProposal.proposed_content)) {
        fail('repeated_ineffective_attempt', 'Two attempts produced the same unresolved error without a meaningful source change.');
      }
      previousFingerprint = attempt.error_fingerprint;
      previousNormalizedContent = normalizedContent(currentProposal.proposed_content);

      if (retryCount >= maxRetries) fail('retry_budget_exhausted', `Trusted checks still fail after ${retryCount} repair attempt(s).`);
      if (remainingTime() <= 0) fail('time_budget_exceeded', 'Repair exceeded its total time budget before requesting a correction.');

      if (retryCount === 0) await options.onRepairStart?.();
      const diagnostics = diagnosticsFor(attempt);
      attempt.diagnostics_forwarded = diagnostics;
      let raw: unknown;
      let parsedData: typeof repairResponseSchema._output | undefined;
      while (!parsedData) {
        if (retryCount >= maxRetries) fail('retry_budget_exhausted', 'No repair attempts remain.');
        retryCount += 1;
        report.repair_attempts_used = retryCount;
        try {
          raw = await requestWithDeadline(adapter, {
            task: currentProposal.task,
            file: authorizedFile,
            model: currentProposal.model,
            currentContent: sanitizeText(currentProposal.proposed_content, MAX_SOURCE_CONTEXT_CHARS),
            diagnostics,
            repairAttempt: retryCount,
            maxRepairAttempts: maxRetries,
            timeoutMs: Math.max(remainingTime(), 1),
          }, Math.max(remainingTime(), 1));
        } catch (error) {
          if (remainingTime() <= 0) fail('time_budget_exceeded', error instanceof Error ? error.message : String(error));
          fail('malformed_repair_response', `Repair model request failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        const parsed = parseRepairResponse(raw);
        if (parsed.success) {
          parsedData = parsed.data;
          malformedCount = 0;
          pendingModelResponse = modelResponseForReport(raw);
          break;
        }
        malformedCount += 1;
        report.attempts.push({
          attempt: report.attempts.length + 1,
          kind: 'repair',
          retry_count: retryCount,
          proposal_valid: false,
          validation_errors: parsed.errors,
          checks_status: 'skipped',
          checks: [],
          modified_files: files,
          model_response: modelResponseForReport(raw),
          duration_ms: 0,
        });
        report.proposal_validity = 'failed';
        if (parsed.unauthorizedFile) fail('unauthorized_file_modification', 'Repair response attempted to select a file path.');
        if (malformedCount >= 2) fail('repeated_malformed_response', 'The local worker produced malformed repair responses repeatedly.');
        if (retryCount >= maxRetries) fail('malformed_repair_response', 'The local worker produced a malformed repair response and no retries remain.');
      }

      const repairProposal = {
        task: currentProposal.task,
        file: authorizedFile,
        model: currentProposal.model,
        summary: parsedData.summary,
        proposed_content: parsedData.proposed_content,
        checks: parsedData.checks,
        risks: parsedData.risks,
        original_sha256: expectedCurrentHash,
      };
      const rawHash = hash(repairProposal.proposed_content);
      if (proposalHashes.has(rawHash)) {
        report.attempts.push({
          attempt: report.attempts.length + 1,
          kind: 'repair',
          retry_count: retryCount,
          proposal_valid: false,
          proposal_hash: rawHash,
          proposal_summary: repairProposal.summary,
          validation_errors: ['Repair repeats an identical proposal.'],
          checks_status: 'skipped',
          checks: [],
          modified_files: files,
          model_response: modelResponseForReport(raw),
          duration_ms: 0,
        });
        report.proposal_validity = 'failed';
        fail('identical_proposal', 'The local worker repeated an identical proposal.');
      }

      const repairDir = resolve(worktreePath, '.agent-proposals');
      await mkdir(repairDir, { recursive: true, mode: 0o700 });
      const repairPath = resolve(repairDir, `${taskId}-${retryCount}.json`);
      await writeFile(repairPath, JSON.stringify(repairProposal), { flag: 'wx', mode: 0o600 });
      const repairValidation = await validateProposal({ project: worktreePath, proposalPath: repairPath, protectedPaths: EXECUTION_PROTECTED_PATHS });
      await rm(repairPath, { force: true });
      if (!repairValidation.valid || !repairValidation.diff || repairValidation.originalSha256 !== expectedCurrentHash) {
        report.attempts.push({
          attempt: report.attempts.length + 1,
          kind: 'repair',
          retry_count: retryCount,
          proposal_valid: false,
          proposal_hash: rawHash,
          proposal_summary: repairProposal.summary,
          validation_errors: repairValidation.errors,
          checks_status: 'skipped',
          checks: [],
          modified_files: files,
          model_response: modelResponseForReport(raw),
          duration_ms: 0,
        });
        report.proposal_validity = 'failed';
        fail('repair_validation_failed', `Repair proposal validation failed: ${repairValidation.errors.join('; ')}`);
      }
      currentProposal = repairProposal;
      currentDiff = repairValidation.diff!;
      expectedCurrentHash = repairValidation.originalSha256!;
    }

    report.final_patch_path = await savePatch(projectRoot, worktreePath, taskId, authorizedFile);
  } catch (error) {
    if (report.errors.length === 0) report.errors.push(error instanceof Error ? error.message : String(error));
    report.status = 'failed';
    report.cloud_escalation_recommended = true;
    if (worktreeCreated && authorizedFile && !report.final_patch_path) {
      try {
        report.final_patch_path = await savePatch(projectRoot, worktreePath, taskId, authorizedFile);
      } catch (patchError) {
        report.errors.push(patchError instanceof Error ? patchError.message : String(patchError));
      }
    }
  } finally {
    if (worktreeCreated && !options.keepWorktree) {
      const removed = await runProcess('git', ['-c', `core.hooksPath=${disabledHooks}`, 'worktree', 'remove', '--force', worktreePath], projectRoot);
      if (removed.code === 0) report.worktree.cleaned = true;
      else {
        report.worktree.preserved = true;
        report.status = 'failed';
        report.stop_reason = 'internal_error';
        report.errors.push(`Repair worktree cleanup failed: ${removed.error ?? removed.stderr}`);
      }
    } else if (worktreeCreated) {
      report.worktree.preserved = true;
    }
    await releaseExecutionLock(lock);
    report.completed_at = new Date().toISOString();
    report.duration_ms = Date.now() - started;
    await writeJsonArtifact(projectRoot, taskId, report);
  }

  return report;
}
