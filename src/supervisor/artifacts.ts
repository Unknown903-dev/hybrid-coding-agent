import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { resolveSafeTargetPath } from '../proposal-validation.js';

const MAX_PLAN_BYTES = 1_000_000;
const MAX_REPORT_BYTES = 1_000_000;
const MAX_PATCH_BYTES = 2_000_000;

export const localRunReportSchema = z.object({
  task_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  status: z.enum(['passed', 'failed']),
  task: z.string().max(10_000).optional(),
  model: z.string().max(500).optional(),
  proposed_file: z.string().trim().min(1).max(1_000),
  proposal_summary: z.string().max(10_000).optional(),
  structural_validation: z.unknown().optional(),
  application: z.unknown().optional(),
  checks: z.unknown().optional(),
  proposal_validity: z.unknown().optional(),
  automated_checks: z.unknown().optional(),
  semantic_review: z.unknown().optional(),
  attempts: z.unknown().optional(),
  stop_reason: z.string().max(500).optional(),
  errors: z.array(z.string().max(10_000)).max(100).default([]),
}).passthrough();

export type LocalRunReport = z.infer<typeof localRunReportSchema>;

function outside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function safeArtifact(projectRoot: string, input: string, maxBytes: number, extension: string): Promise<string> {
  const runsRoot = await realpath(resolve(projectRoot, '.agent-runs')).catch(() => resolve(projectRoot, '.agent-runs'));
  const candidate = resolve(projectRoot, input);
  if (!isAbsolute(input) && outside(runsRoot, candidate)) throw new Error('Supervisor artifacts must be inside .agent-runs.');
  const stat = await lstat(candidate).catch(() => { throw new Error(`Artifact is missing: ${input}`); });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Supervisor artifact must be a regular non-symlink file.');
  if (!input.endsWith(extension)) throw new Error(`Supervisor artifact must use the ${extension} extension.`);
  if (stat.size === 0 || stat.size > maxBytes) throw new Error(`Supervisor artifact size must be between 1 and ${maxBytes} bytes.`);
  const actual = await realpath(candidate);
  if (outside(runsRoot, actual)) throw new Error('Supervisor artifacts must be inside .agent-runs.');
  return actual;
}

export async function readPlanArtifact(projectRoot: string, input: string): Promise<unknown> {
  const path = await safeArtifact(projectRoot, input, MAX_PLAN_BYTES, '.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Malformed plan JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readRunArtifact(projectRoot: string, input: string): Promise<{ report: LocalRunReport; patch: string }> {
  const path = await safeArtifact(projectRoot, input, MAX_REPORT_BYTES, '.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Malformed run report JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = localRunReportSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid run report: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  await resolveSafeTargetPath(projectRoot, parsed.data.proposed_file, ['package.json', '.agent-validation.json']);
  const patchPath = await safeArtifact(projectRoot, `.agent-runs/${parsed.data.task_id}.patch`, MAX_PATCH_BYTES, '.patch');
  const patch = await readFile(patchPath, 'utf8');
  if (parsed.data.proposed_file) validatePatchScope(patch, parsed.data.proposed_file);
  return { report: parsed.data, patch };
}

function validatePatchScope(patch: string, expectedFile: string): void {
  if (isAbsolute(expectedFile) || expectedFile.split(/[\\/]/).includes('..')) throw new Error('Run report contains an unsafe proposed file path.');
  const normalizedExpected = expectedFile.replaceAll('\\', '/');
  const segments = normalizedExpected.split('/');
  const name = segments.at(-1) ?? '';
  if (segments.some(segment => ['.git', '.agent-runs', '.agent-proposals', '.agent-worktrees', '.aws', '.ssh', '.codex', 'node_modules'].includes(segment)) ||
      name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx)$/i.test(name)) {
    throw new Error('Run report references a protected patch path.');
  }
  const headers = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (headers.length === 0) throw new Error('Patch has no reviewable Git diff header.');
  for (const header of headers) {
    if (header[1] !== normalizedExpected || header[2] !== normalizedExpected) {
      throw new Error('Patch contains changes outside the report authorized file.');
    }
  }
}

export function sanitizeCloudText(text: string, maxChars: number): string {
  const sanitized = text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  return sanitized.length <= maxChars ? sanitized : `${sanitized.slice(0, maxChars)}\n[TRUNCATED]`;
}

export function summarizedRunReport(report: LocalRunReport): string {
  const safe = {
    task_id: report.task_id,
    status: report.status,
    task: report.task,
    proposed_file: report.proposed_file,
    proposal_summary: report.proposal_summary,
    structural_validation: report.structural_validation,
    application: report.application,
    checks: report.checks,
    proposal_validity: report.proposal_validity,
    automated_checks: report.automated_checks,
    semantic_review: report.semantic_review,
    attempts: report.attempts,
    stop_reason: report.stop_reason,
    errors: report.errors,
  };
  return sanitizeCloudText(JSON.stringify(safe), 30_000);
}
