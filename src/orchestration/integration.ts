import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { acquireExecutionLock, EXECUTION_PROTECTED_PATHS, releaseExecutionLock } from '../proposal-execution.js';
import { resolveSafeTargetPath, validateProposal } from '../proposal-validation.js';
import { readRunArtifact, sanitizeCloudText } from '../supervisor/artifacts.js';
import { supervisorReviewSchema, type SupervisorReview } from '../supervisor/schemas.js';
import { approvalRecordSchema, integrationAuditSchema, type ApprovalRecord, type IntegrationAudit } from './integration-schemas.js';
import { orchestrationReportSchema, type OrchestrationReport } from './schemas.js';

const execFileAsync = promisify(execFile);
const MAX_JSON_BYTES = 1_000_000;
const MAX_PATCH_BYTES = 2_000_000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RepositoryIdentity {
  root: string;
  gitDir: string;
  id: string;
  head: string;
}

interface RunBundle {
  report: OrchestrationReport;
  reportPath: string;
  reportBytes: Buffer;
  executionReportPath: string;
  executionReportBytes: Buffer;
  patchPath: string;
  patchBytes: Buffer;
  patch: string;
  reviewPath?: string;
  reviewBytes?: Buffer;
  review?: SupervisorReview;
  file: string;
  originalSha256?: string;
}

export interface RunInspection {
  runId: string;
  task: string;
  changedFiles: string[];
  diffSummary: { addedLines: number; removedLines: number; changedLines: number; patchSha256: string };
  patch: string;
  automatedValidation: OrchestrationReport['validation'];
  cloudReviewVerdict?: SupervisorReview['verdict'];
  warnings: string[];
  cloudUsage: OrchestrationReport['cloud_usage'];
  eligibleForApproval: boolean;
  ineligibilityReasons: string[];
}

export interface ApprovalOptions {
  project: string;
  runId: string;
  authorized: boolean;
  authorizationMethod: 'explicit_flag' | 'interactive_confirmation';
}

export interface ApprovalResult {
  record: ApprovalRecord;
  approvalPath: string;
}

export interface PatchApplicationAdapter {
  apply(projectRoot: string, patchPath: string): Promise<void>;
}

export interface IntegrationOptions {
  project: string;
  runId: string;
  adapter?: PatchApplicationAdapter;
}

export interface IntegrationResult {
  audit: IntegrationAudit;
  auditPath: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function git(root: string, args: string[], maxBuffer = 2_000_000): Promise<string> {
  try {
    return (await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 30_000, maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })).stdout;
  } catch (error) {
    throw new Error(`Git operation failed: ${sanitizeCloudText(error instanceof Error ? error.message : String(error), 2_000)}`);
  }
}

async function repositoryIdentity(project: string): Promise<RepositoryIdentity> {
  const root = await realpath(project);
  const marker = await lstat(resolve(root, '.git')).catch(() => undefined);
  if (!marker || (!marker.isDirectory() && !marker.isFile())) throw new Error(`Not a Git repository: ${root}`);
  const top = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  if (top !== root) throw new Error('The supplied project must be the target Git worktree root.');
  const gitDir = await realpath((await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error('Git HEAD is invalid.');
  return { root, gitDir, head: head.toLowerCase(), id: sha256(`${root}\0${gitDir}`) };
}

async function boundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const stat = await lstat(path).catch(() => { throw new Error(`Required artifact is missing: ${path}`); });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact must be a regular non-symlink file: ${path}`);
  if (stat.size === 0 || stat.size > maxBytes) throw new Error(`Artifact has an invalid size: ${path}`);
  return readFile(path);
}

async function runArtifact(root: string, input: string, extension: string, maxBytes: number): Promise<{ path: string; bytes: Buffer }> {
  const runs = await realpath(resolve(root, '.agent-runs'));
  const lexical = resolve(root, input);
  if (!inside(runs, lexical)) throw new Error('Run artifact path escapes .agent-runs.');
  const supplied = await lstat(lexical).catch(() => { throw new Error(`Run artifact is missing: ${input}`); });
  if (!supplied.isFile() || supplied.isSymbolicLink()) throw new Error('Run artifact must be a regular non-symlink file.');
  const actual = await realpath(lexical).catch(() => { throw new Error(`Run artifact is missing: ${input}`); });
  if (!inside(runs, actual) || !actual.endsWith(extension)) throw new Error('Run artifact has an unsafe path or extension.');
  return { path: actual, bytes: await boundedFile(actual, maxBytes) };
}

function parseJson<T>(bytes: Buffer, label: string, parse: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Malformed ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function patchFiles(patch: string, expectedFile: string): string[] {
  if (/^(?:new file mode|deleted file mode|old mode|new mode|rename (?:from|to)|copy (?:from|to)|GIT binary patch|Binary files )/m.test(patch) ||
      /^--- \/dev\/null$|^\+\+\+ \/dev\/null$/m.test(patch)) {
    throw new Error('Patch contains unsupported creation, deletion, rename, copy, binary, or mode-changing operations.');
  }
  const headers = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (headers.length !== 1 || headers[0]![1] !== expectedFile || headers[0]![2] !== expectedFile) {
    throw new Error('Patch scope does not exactly match the single authorized file.');
  }
  if (!patch.includes(`--- a/${expectedFile}\n`) || !patch.includes(`+++ b/${expectedFile}\n`)) {
    throw new Error('Patch has malformed or inconsistent file headers.');
  }
  if ([...patch.matchAll(/^--- /gm)].length !== 1 || [...patch.matchAll(/^\+\+\+ /gm)].length !== 1) {
    throw new Error('Patch contains unexpected additional file headers.');
  }
  return [expectedFile];
}

function diffSummary(patch: string): { addedLines: number; removedLines: number; changedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) addedLines += 1;
    if (line.startsWith('-') && !line.startsWith('---')) removedLines += 1;
  }
  return { addedLines, removedLines, changedLines: addedLines + removedLines };
}

async function loadRunBundle(project: string, runId: string): Promise<{ identity: RepositoryIdentity; bundle: RunBundle }> {
  if (!RUN_ID.test(runId)) throw new Error('run-id must be a UUID.');
  const identity = await repositoryIdentity(project);
  const orchestration = await runArtifact(identity.root, `.agent-runs/${runId}-orchestration.json`, '.json', MAX_JSON_BYTES);
  const report = parseJson(orchestration.bytes, 'orchestration report', value => orchestrationReportSchema.parse(value));
  if (report.run_id !== runId) throw new Error('Orchestration report run ID does not match the requested run.');
  if (await realpath(report.project).catch(() => '') !== identity.root) throw new Error('Orchestration report targets a different repository.');
  if (!report.selected_task || report.selected_task.operation !== 'modify_existing' || report.selected_task.file_scope.length !== 1) {
    throw new Error('Orchestration report does not contain one supported existing-file task.');
  }
  if (!report.execution_report_path || !report.final_patch_path) throw new Error('Orchestration report has no execution report or final patch reference.');
  const executionArtifact = await runArtifact(identity.root, report.execution_report_path, '.json', MAX_JSON_BYTES);
  const local = await readRunArtifact(identity.root, executionArtifact.path);
  const expectedPatch = await runArtifact(identity.root, `.agent-runs/${local.report.task_id}.patch`, '.patch', MAX_PATCH_BYTES);
  const referencedPatch = await runArtifact(identity.root, report.final_patch_path, '.patch', MAX_PATCH_BYTES);
  if (expectedPatch.path !== referencedPatch.path || !expectedPatch.bytes.equals(referencedPatch.bytes)) {
    throw new Error('Patch reference is inconsistent with the execution report.');
  }
  const file = report.selected_task.file_scope[0]!;
  if (local.report.proposed_file !== file) throw new Error('Execution report file scope differs from the selected task.');
  const patch = referencedPatch.bytes.toString('utf8');
  patchFiles(patch, file);

  let reviewPath: string | undefined;
  let reviewBytes: Buffer | undefined;
  let review: SupervisorReview | undefined;
  if (report.cloud_review_path) {
    const artifact = await runArtifact(identity.root, report.cloud_review_path, '.json', MAX_JSON_BYTES);
    reviewPath = artifact.path;
    reviewBytes = artifact.bytes;
    review = parseJson(artifact.bytes, 'cloud review', value => supervisorReviewSchema.parse(value));
    if (report.final_review.verdict !== review.verdict) throw new Error('Cloud review verdict is inconsistent with the orchestration report.');
  } else if (report.final_review.status === 'completed' || report.final_review.verdict !== undefined) {
    throw new Error('Orchestration report claims a completed review without a review artifact.');
  }

  let originalSha256: string | undefined;
  if (report.proposal_path) {
    const validation = await validateProposal({
      project: identity.root,
      proposalPath: report.proposal_path,
      protectedPaths: EXECUTION_PROTECTED_PATHS,
    });
    if (!validation.proposal || validation.proposal.file !== file || !validation.proposal.original_sha256) {
      throw new Error('Initial proposal is missing, malformed, or inconsistent with the approved file.');
    }
    originalSha256 = validation.proposal.original_sha256;
  }

  return {
    identity,
    bundle: {
      report,
      reportPath: orchestration.path,
      reportBytes: orchestration.bytes,
      executionReportPath: executionArtifact.path,
      executionReportBytes: executionArtifact.bytes,
      patchPath: referencedPatch.path,
      patchBytes: referencedPatch.bytes,
      patch,
      ...(reviewPath && reviewBytes && review ? { reviewPath, reviewBytes, review } : {}),
      file,
      ...(originalSha256 ? { originalSha256 } : {}),
    },
  };
}

export async function inspectOrchestrationRun(project: string, runId: string): Promise<RunInspection> {
  const { identity, bundle } = await loadRunBundle(project, runId);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const local = await readRunArtifact(identity.root, bundle.executionReportPath);
  if (bundle.report.state !== 'awaiting_human_review') reasons.push(`Run state is ${bundle.report.state}, not awaiting_human_review.`);
  if (bundle.report.validation.plan !== 'passed' || bundle.report.validation.proposal !== 'passed' || bundle.report.validation.automated_checks !== 'passed') {
    reasons.push('Planning, proposal, and trusted automated validation must all have passed.');
  }
  if (local.report.status !== 'passed' || local.report.automated_checks !== 'passed') reasons.push('Execution report does not record passing trusted checks.');
  if (!bundle.review || bundle.review.verdict !== 'ready_for_human_review' || bundle.report.final_review.status !== 'completed') {
    reasons.push('A completed ready_for_human_review cloud review is required.');
  }
  if (bundle.report.failure_reason) warnings.push(bundle.report.failure_reason);
  if (bundle.report.failure_reason) reasons.push('The orchestration report contains a failure reason.');
  if (bundle.review) {
    warnings.push(...bundle.review.remaining_risks);
    warnings.push(...bundle.review.findings.filter(finding => finding.severity !== 'info').map(finding => finding.summary));
  }
  warnings.push(...local.report.errors);
  const target = await resolveSafeTargetPath(identity.root, bundle.file, EXECUTION_PROTECTED_PATHS).catch(error => {
    reasons.push(error instanceof Error ? error.message : String(error));
    return undefined;
  });
  if (target && bundle.originalSha256) {
    const current = sha256(await readFile(target.path));
    if (current !== bundle.originalSha256) reasons.push('The authorized source changed after proposal generation.');
  } else if (!bundle.originalSha256) {
    reasons.push('The run does not contain a verifiable original source digest.');
  }
  const summary = diffSummary(bundle.patch);
  return {
    runId,
    task: bundle.report.request,
    changedFiles: [bundle.file],
    diffSummary: { ...summary, patchSha256: sha256(bundle.patchBytes) },
    patch: bundle.patch,
    automatedValidation: bundle.report.validation,
    ...(bundle.review ? { cloudReviewVerdict: bundle.review.verdict } : {}),
    warnings: [...new Set(warnings)],
    cloudUsage: bundle.report.cloud_usage,
    eligibleForApproval: reasons.length === 0,
    ineligibilityReasons: [...new Set(reasons)],
  };
}

async function stateDirectory(root: string): Promise<string> {
  const state = resolve(root, '.agent-state');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const stat = await lstat(state);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('.agent-state must be a private regular directory.');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('.agent-state permissions are too broad.');
  const actual = await realpath(state);
  if (!inside(root, actual)) throw new Error('.agent-state escapes the repository.');
  return actual;
}

async function privateStateSubdirectory(root: string, name: 'approvals' | 'integrations'): Promise<string> {
  const state = await stateDirectory(root);
  const path = resolve(state, name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`.agent-state/${name} must be a private regular directory.`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error(`.agent-state/${name} permissions are too broad.`);
  const actual = await realpath(path);
  if (!inside(state, actual)) throw new Error(`.agent-state/${name} escapes protected agent state.`);
  return actual;
}

async function signingKey(root: string, create: boolean): Promise<Buffer> {
  const state = await stateDirectory(root);
  const path = resolve(state, 'approval-hmac.key');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error('Approval signing key is malformed.');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Approval signing key permissions are too broad.');
    return readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    const key = randomBytes(32);
    await writeFile(path, key, { flag: 'wx', mode: 0o600 });
    return key;
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sign(value: Record<string, unknown>, key: Buffer): string {
  return createHmac('sha256', key).update(stable(value)).digest('hex');
}

function verifySigned(value: ApprovalRecord | IntegrationAudit, key: Buffer): void {
  const { signature, ...payload } = value;
  const expected = Buffer.from(sign(payload, key), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Audit signature verification failed; the record may have been altered.');
}

async function approvalPath(root: string, runId: string): Promise<string> {
  const approvals = await privateStateSubdirectory(root, 'approvals');
  return resolve(approvals, `${runId}.approval.json`);
}

export async function approveOrchestrationRun(options: ApprovalOptions): Promise<ApprovalResult> {
  if (!options.authorized) throw new Error('Approval requires explicit --yes authorization or interactive confirmation.');
  const inspection = await inspectOrchestrationRun(options.project, options.runId);
  if (!inspection.eligibleForApproval) throw new Error(`Run is not eligible for approval: ${inspection.ineligibilityReasons.join('; ')}`);
  const { identity, bundle } = await loadRunBundle(options.project, options.runId);
  const target = await resolveSafeTargetPath(identity.root, bundle.file, EXECUTION_PROTECTED_PATHS);
  const sourceHash = sha256(await readFile(target.path));
  if (!bundle.originalSha256 || sourceHash !== bundle.originalSha256) throw new Error('The original source changed after the run.');
  await git(identity.root, ['apply', '--check', '--whitespace=nowarn', bundle.patchPath]);
  const key = await signingKey(identity.root, true);
  const payload = {
    schema_version: '1.0' as const,
    record_type: 'human_patch_approval' as const,
    approval_id: randomUUID(),
    run_id: options.runId,
    approved_at: new Date().toISOString(),
    authorization_method: options.authorizationMethod,
    repository_root: identity.root,
    repository_id: identity.id,
    head_at_approval: identity.head,
    patch_path: bundle.patchPath,
    patch_sha256: sha256(bundle.patchBytes),
    approved_files: [bundle.file],
    source_sha256: { [bundle.file]: sourceHash },
    orchestration_report_sha256: sha256(bundle.reportBytes),
    execution_report_sha256: sha256(bundle.executionReportBytes),
    review_report_sha256: sha256(bundle.reviewBytes!),
    human_approval_required_after_integration: true as const,
  };
  const record = approvalRecordSchema.parse({ ...payload, signature: sign(payload, key) });
  const path = await approvalPath(identity.root, options.runId);
  await writeFile(path, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  return { record, approvalPath: path };
}

async function loadApproval(identity: RepositoryIdentity, runId: string): Promise<{ record: ApprovalRecord; path: string }> {
  const path = await approvalPath(identity.root, runId);
  const bytes = await boundedFile(path, MAX_JSON_BYTES);
  const record = parseJson(bytes, 'approval record', value => approvalRecordSchema.parse(value));
  const key = await signingKey(identity.root, false);
  verifySigned(record, key);
  return { record, path };
}

function statusEntries(status: string): Array<{ code: string; path: string }> {
  const entries = status.split('\0').filter(Boolean);
  const result: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    result.push({ code: entry.slice(0, 2), path: entry.slice(3).replaceAll('\\', '/') });
    if ('RC'.includes(entry[0] ?? '') || 'RC'.includes(entry[1] ?? '')) index += 1;
  }
  return result;
}

const AGENT_OWNED_DIRECTORIES = ['.agent-runs', '.agent-proposals', '.agent-worktrees', '.agent-state'];

function relevantStatusEntries(status: string): Array<{ code: string; path: string }> {
  return statusEntries(status).filter(entry =>
    entry.code !== '??' || !AGENT_OWNED_DIRECTORIES.some(directory => entry.path === directory || entry.path.startsWith(`${directory}/`)),
  );
}

async function headFile(root: string, path: string): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    execFile('git', ['-C', root, 'show', `HEAD:${path}`], {
      encoding: 'buffer', timeout: 30_000, maxBuffer: MAX_PATCH_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }, (error, stdout) => {
      if (error) reject(error);
      else resolveResult(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function successfulIntegrationExists(root: string, runId: string, key: Buffer): Promise<boolean> {
  const integrations = await privateStateSubdirectory(root, 'integrations');
  const names = await readdir(integrations);
  const matching = names.filter(value => value.startsWith(`${runId}-`) && value.endsWith('.json'));
  if (matching.length > 1_000) throw new Error('Too many integration audit records exist for this run.');
  for (const name of matching) {
    try {
      const bytes = await boundedFile(resolve(integrations, name), MAX_JSON_BYTES);
      const audit = parseJson(bytes, 'integration audit', value => integrationAuditSchema.parse(value));
      verifySigned(audit, key);
      if (audit.run_id === runId && audit.status === 'succeeded') return true;
    } catch {
      throw new Error('An integration audit record is malformed or has been altered.');
    }
  }
  return false;
}

async function writeAudit(root: string, audit: Omit<IntegrationAudit, 'signature'>, key: Buffer): Promise<string> {
  const integrations = await privateStateSubdirectory(root, 'integrations');
  const record = integrationAuditSchema.parse({ ...audit, signature: sign(audit, key) });
  const path = resolve(integrations, `${audit.run_id}-${audit.integration_id}.json`);
  const temporary = resolve(integrations, `.${audit.integration_id}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return path;
}

class GitPatchApplicationAdapter implements PatchApplicationAdapter {
  async apply(projectRoot: string, patchPath: string): Promise<void> {
    await git(projectRoot, ['apply', '--whitespace=nowarn', patchPath]);
  }
}

export async function integrateApprovedRun(options: IntegrationOptions): Promise<IntegrationResult> {
  if (!RUN_ID.test(options.runId)) throw new Error('run-id must be a UUID.');
  const identity = await repositoryIdentity(options.project);
  const key = await signingKey(identity.root, false);
  const approval = await loadApproval(identity, options.runId);
  if (await successfulIntegrationExists(identity.root, options.runId, key)) throw new Error('This approved run was already integrated successfully.');
  if (approval.record.run_id !== options.runId || approval.record.repository_root !== identity.root || approval.record.repository_id !== identity.id) {
    throw new Error('Approval record is bound to a different run or repository.');
  }
  const integrationId = randomUUID();
  const attemptedAt = new Date().toISOString();
  let lock: Awaited<ReturnType<typeof acquireExecutionLock>> | undefined;
  let backups = new Map<string, Buffer>();
  let applicationStarted = false;
  let changedFiles: string[] = [];
  let auditPath = '';
  let verifiedPatchPath: string | undefined;
  try {
    if (approval.record.approved_files.length !== 1) throw new Error('Milestone 6B supports exactly one approved file.');
    const file = approval.record.approved_files[0]!;
    lock = await acquireExecutionLock(identity.root, `${identity.root}\0${file}`, integrationId);
    const { identity: currentIdentity, bundle } = await loadRunBundle(identity.root, options.runId);
    if (currentIdentity.id !== identity.id || currentIdentity.head !== approval.record.head_at_approval) {
      throw new Error('Repository HEAD or identity changed after approval.');
    }
    if (sha256(bundle.patchBytes) !== approval.record.patch_sha256 || bundle.patchPath !== approval.record.patch_path) {
      throw new Error('Approved patch is missing or has been altered.');
    }
    if (sha256(bundle.reportBytes) !== approval.record.orchestration_report_sha256 ||
        sha256(bundle.executionReportBytes) !== approval.record.execution_report_sha256 ||
        !bundle.reviewBytes || sha256(bundle.reviewBytes) !== approval.record.review_report_sha256) {
      throw new Error('An approved run or review report was altered after approval.');
    }
    patchFiles(bundle.patch, file);
    const integrations = await privateStateSubdirectory(identity.root, 'integrations');
    verifiedPatchPath = resolve(integrations, `.${integrationId}.approved.patch`);
    await writeFile(verifiedPatchPath, bundle.patchBytes, { flag: 'wx', mode: 0o600 });
    const dirty = relevantStatusEntries(await git(identity.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    if (dirty.length > 0) throw new Error('The target working tree or index has tracked changes or untracked files outside protected agent artifacts.');
    const target = await resolveSafeTargetPath(identity.root, file, EXECUTION_PROTECTED_PATHS);
    const original = await readFile(target.path);
    if (sha256(original) !== approval.record.source_sha256[file]) throw new Error('The approved source file is stale.');
    backups.set(target.path, original);
    await git(identity.root, ['apply', '--check', '--whitespace=nowarn', verifiedPatchPath]);
    applicationStarted = true;
    await (options.adapter ?? new GitPatchApplicationAdapter()).apply(identity.root, verifiedPatchPath);
    changedFiles = relevantStatusEntries(await git(identity.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).map(entry => entry.path);
    if (changedFiles.length !== 1 || changedFiles[0] !== file) throw new Error('Patch application changed files outside the approved scope.');
    const actualPatch = await git(identity.root, ['diff', '--no-ext-diff', '--binary', '--', file], MAX_PATCH_BYTES);
    if (actualPatch !== bundle.patch) throw new Error('Resulting working-tree diff does not exactly match the approved patch.');
    const headAfter = (await git(identity.root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim().toLowerCase();
    if (headAfter !== identity.head) throw new Error('Git HEAD changed during integration.');
    const auditPayload: Omit<IntegrationAudit, 'signature'> = {
      schema_version: '1.0', record_type: 'patch_integration_audit', integration_id: integrationId,
      run_id: options.runId, attempted_at: attemptedAt, completed_at: new Date().toISOString(),
      repository_root: identity.root, repository_id: identity.id, head_before_integration: identity.head,
      patch_sha256: approval.record.patch_sha256, approval_path: approval.path, approved_files: [file],
      status: 'succeeded', changed_files: changedFiles,
      commit_created: false, push_performed: false, merge_performed: false, deployment_performed: false,
    };
    auditPath = await writeAudit(identity.root, auditPayload, key);
    return { audit: integrationAuditSchema.parse({ ...auditPayload, signature: sign(auditPayload, key) }), auditPath };
  } catch (error) {
    let message = sanitizeCloudText(error instanceof Error ? error.message : String(error), 4_000);
    if (applicationStarted) {
      const rollbackErrors: string[] = [];
      for (const [path, content] of backups) {
        await writeFile(path, content).catch(rollbackError => rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
      }
      const entries = relevantStatusEntries(await git(identity.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''));
      for (const entry of entries) {
        const path = resolve(identity.root, entry.path);
        if (!inside(identity.root, path)) {
          rollbackErrors.push(`Unsafe rollback path: ${entry.path}`);
          continue;
        }
        if (entry.code === '??') {
          await rm(path, { recursive: true, force: true }).catch(rollbackError => rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)));
          continue;
        }
        if (backups.has(path)) continue;
        try {
          const stat = await lstat(path).catch(() => undefined);
          if (stat?.isSymbolicLink()) throw new Error(`Cannot safely restore symlink ${entry.path}`);
          await writeFile(path, await headFile(identity.root, entry.path));
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      }
      const remaining = relevantStatusEntries(await git(identity.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).catch(() => ''));
      if (remaining.length > 0) rollbackErrors.push('Working tree was not clean after rollback.');
      if (rollbackErrors.length > 0) message = sanitizeCloudText(`${message} Rollback errors: ${rollbackErrors.join('; ')}`, 4_000);
    }
    const failurePayload: Omit<IntegrationAudit, 'signature'> = {
      schema_version: '1.0', record_type: 'patch_integration_audit', integration_id: integrationId,
      run_id: options.runId, attempted_at: attemptedAt, completed_at: new Date().toISOString(),
      repository_root: identity.root, repository_id: identity.id, head_before_integration: identity.head,
      patch_sha256: approval.record.patch_sha256, approval_path: approval.path,
      approved_files: approval.record.approved_files, status: 'failed', changed_files: [], error: message,
      commit_created: false, push_performed: false, merge_performed: false, deployment_performed: false,
    };
    await writeAudit(identity.root, failurePayload, key).catch(() => undefined);
    throw new Error(message);
  } finally {
    if (verifiedPatchPath) await rm(verifiedPatchPath, { force: true }).catch(() => undefined);
    await releaseExecutionLock(lock);
  }
}
