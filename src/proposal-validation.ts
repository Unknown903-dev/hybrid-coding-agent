import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { createTwoFilesPatch, diffLines } from 'diff';
import { createHash } from 'node:crypto';
import { formatSchemaIssues, proposalSchema, type Proposal } from './proposal-schema.js';

const MAX_PROPOSAL_BYTES = 1_000_000;
const MAX_SOURCE_BYTES = 200_000;
const PROTECTED_SEGMENTS = new Set([
  '.git', '.agent-proposals', '.agent-runs', '.agent-worktrees', '.agent-state', '.aws', '.codex', '.ssh', 'node_modules',
  '.github', '.gitlab', '.circleci', 'dist', 'build', 'coverage',
]);
const PROTECTED_FILES = new Set(['.env', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const CREATABLE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.mjs', '.php', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx', '.vue',
]);

export interface DiffThresholds {
  changedLines: number;
  changedRatio: number;
  formattingOnlyLines: number;
}

export interface DiffAnalysis {
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
  changedLines: number;
  changedRatio: number;
  formattingOnly: boolean;
  findings: string[];
  suspicious: boolean;
}

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  proposalPath: string;
  projectRoot: string;
  targetPath?: string;
  originalSha256?: string;
  proposal?: Proposal;
  diff?: DiffAnalysis;
  requiresManualReview: boolean;
}

export interface ValidationOptions {
  project: string;
  proposalPath: string;
  thresholds?: Partial<DiffThresholds>;
  protectedPaths?: string[];
}

const DEFAULT_THRESHOLDS: DiffThresholds = {
  changedLines: 200,
  changedRatio: 0.5,
  formattingOnlyLines: 20,
};

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function isProtected(relativePath: string, extraProtectedPaths: string[]): boolean {
  const normalized = relativePath.split(sep).join('/');
  const segments = normalized.split('/');
  const normalizedLower = normalized.toLowerCase();
  const name = (segments.at(-1) ?? '').toLowerCase();
  if (segments.some(segment => PROTECTED_SEGMENTS.has(segment.toLowerCase()))) return true;
  if (PROTECTED_FILES.has(name) || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx)$/i.test(name)) return true;
  return extraProtectedPaths.some(protectedPath => {
    const normalizedProtected = protectedPath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
    return normalizedLower === normalizedProtected || normalizedLower.startsWith(`${normalizedProtected}/`);
  });
}

export function generateDiff(
  file: string,
  original: string,
  proposed: string,
  overrides: Partial<DiffThresholds> = {},
): DiffAnalysis {
  const thresholds: DiffThresholds = {
    changedLines: overrides.changedLines ?? DEFAULT_THRESHOLDS.changedLines,
    changedRatio: overrides.changedRatio ?? DEFAULT_THRESHOLDS.changedRatio,
    formattingOnlyLines: overrides.formattingOnlyLines ?? DEFAULT_THRESHOLDS.formattingOnlyLines,
  };
  let addedLines = 0;
  let removedLines = 0;
  for (const change of diffLines(original, proposed)) {
    if (change.added) addedLines += change.count ?? lineCount(change.value);
    if (change.removed) removedLines += change.count ?? lineCount(change.value);
  }
  const changedLines = addedLines + removedLines;
  const baselineLines = Math.max(lineCount(original), 1);
  const changedRatio = changedLines / baselineLines;
  const formattingOnly = original.replace(/\s/g, '') === proposed.replace(/\s/g, '');
  const findings: string[] = [];

  if (changedLines > thresholds.changedLines) {
    findings.push(`Large diff: ${changedLines} changed lines exceeds the ${thresholds.changedLines}-line review threshold.`);
  }
  if (changedRatio > thresholds.changedRatio) {
    findings.push(`Broad diff: changed lines are ${(changedRatio * 100).toFixed(1)}% of the original file, above the ${(thresholds.changedRatio * 100).toFixed(1)}% review threshold.`);
  }
  if (formattingOnly && changedLines >= thresholds.formattingOnlyLines) {
    findings.push(`Large formatting-only diff: ${changedLines} lines changed without changing non-whitespace content.`);
  }

  return {
    unifiedDiff: createTwoFilesPatch(`a/${file}`, `b/${file}`, original, proposed, 'original', 'proposed', { context: 3 }),
    addedLines,
    removedLines,
    changedLines,
    changedRatio,
    formattingOnly,
    findings,
    suspicious: findings.length > 0,
  };
}

async function safeProposalPath(projectRoot: string, inputPath: string): Promise<string> {
  const resolved = resolve(projectRoot, inputPath);
  if (!isAbsolute(inputPath) && isOutside(projectRoot, resolved)) {
    throw new Error('Proposal path must remain inside the target Git repository.');
  }
  let actual: string;
  let suppliedStat;
  try {
    suppliedStat = await lstat(resolved);
    actual = await realpath(resolved);
  } catch {
    throw new Error(`Proposal path is not a readable file: ${inputPath}`);
  }
  if (isOutside(projectRoot, actual)) {
    if (suppliedStat.isSymbolicLink()) throw new Error('Proposal path escapes the repository through a symlink.');
    throw new Error('Proposal path must remain inside the target Git repository.');
  }
  const actualStat = await lstat(actual);
  if (!actualStat.isFile()) throw new Error('Proposal path must identify a regular file.');
  if (actualStat.size === 0) throw new Error('Proposal file is empty.');
  if (actualStat.size > MAX_PROPOSAL_BYTES) throw new Error(`Proposal file exceeds ${MAX_PROPOSAL_BYTES} bytes.`);
  return actual;
}

export async function resolveSafeTargetPath(
  projectRoot: string,
  file: string,
  extraProtectedPaths: string[],
): Promise<{ path: string; relativePath: string }> {
  if (isAbsolute(file) || win32.isAbsolute(file)) {
    throw new Error('Proposed file path must be relative; absolute paths are rejected.');
  }
  if (file.split(/[\\/]/).includes('..')) {
    throw new Error('Proposed file path contains path traversal.');
  }
  const lexicalPath = resolve(projectRoot, file);
  if (isOutside(projectRoot, lexicalPath)) throw new Error('Proposed file path contains traversal outside the repository.');
  const lexicalRelative = relative(projectRoot, lexicalPath);
  if (!lexicalRelative || isProtected(lexicalRelative, extraProtectedPaths)) {
    throw new Error(`Proposed file is protected: ${file}`);
  }
  const stat = await lstat(lexicalPath);
  const actualPath = await realpath(lexicalPath);
  if (isOutside(projectRoot, actualPath)) throw new Error('Proposed file path escapes the repository through a symlink.');
  const actualStat = stat.isSymbolicLink() ? await lstat(actualPath) : stat;
  if (!actualStat.isFile()) throw new Error('Proposed file path must identify an existing regular file.');
  if (actualStat.size > MAX_SOURCE_BYTES) throw new Error(`Source file exceeds ${MAX_SOURCE_BYTES} bytes.`);
  const relativePath = relative(projectRoot, actualPath);
  if (isProtected(relativePath, extraProtectedPaths)) throw new Error(`Proposed file is protected: ${file}`);
  return { path: actualPath, relativePath };
}

export async function resolveSafeCreationPath(
  projectRoot: string,
  file: string,
  extraProtectedPaths: string[] = [],
): Promise<{ path: string; relativePath: string }> {
  if (!file || isAbsolute(file) || win32.isAbsolute(file) || file.includes('\\') || /[\u0000-\u001f\u007f]/.test(file)) {
    throw new Error('Creation path must be a clean repository-relative path.');
  }
  if (file.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Creation path contains traversal or empty segments.');
  const lexicalPath = resolve(projectRoot, file);
  if (isOutside(projectRoot, lexicalPath)) throw new Error('Creation path escapes the repository.');
  const relativePath = relative(projectRoot, lexicalPath);
  if (!relativePath || isProtected(relativePath, extraProtectedPaths)) throw new Error(`Creation path is protected: ${file}`);
  if (!CREATABLE_EXTENSIONS.has(extname(relativePath).toLowerCase())) throw new Error(`Creation path uses an unsupported file extension: ${file}`);
  const parent = dirname(lexicalPath);
  const parentStat = await lstat(parent).catch(() => undefined);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Creation requires an existing, non-symlink parent directory.');
  const actualParent = await realpath(parent);
  if (isOutside(projectRoot, actualParent) || resolve(projectRoot, relative(projectRoot, actualParent)) !== actualParent) {
    throw new Error('Creation path has a symlinked or escaping ancestor directory.');
  }
  let cursor = actualParent;
  while (cursor !== projectRoot) {
    if (await lstat(resolve(cursor, '.git')).then(() => true, () => false)) throw new Error('Creation inside a Git submodule is unsupported.');
    const next = dirname(cursor);
    if (next === cursor || isOutside(projectRoot, next)) throw new Error('Creation parent escapes the repository.');
    cursor = next;
  }
  if (await lstat(lexicalPath).then(() => true, () => false)) throw new Error(`Creation destination already exists: ${file}`);
  const name = basename(lexicalPath);
  const collision = (await readdir(actualParent)).find(entry => entry.toLowerCase() === name.toLowerCase() && entry !== name);
  if (collision) throw new Error(`Creation path case-collides with existing entry ${collision}.`);
  return { path: lexicalPath, relativePath: relativePath.split(sep).join('/') };
}

export async function validateProposal(options: ValidationOptions): Promise<ValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let projectRoot: string;
  try {
    projectRoot = await realpath(options.project);
    const git = await lstat(resolve(projectRoot, '.git'));
    if (!git.isDirectory() && !git.isFile()) throw new Error();
  } catch {
    projectRoot = resolve(options.project);
    return {
      valid: false,
      errors: [`Not a Git repository: ${projectRoot}`],
      warnings,
      proposalPath: resolve(projectRoot, options.proposalPath),
      projectRoot,
      requiresManualReview: false,
    };
  }

  let proposalPath: string;
  try {
    proposalPath = await safeProposalPath(projectRoot, options.proposalPath);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
      proposalPath: resolve(projectRoot, options.proposalPath),
      projectRoot,
      requiresManualReview: false,
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(proposalPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : String(error);
    return {
      valid: false,
      errors: [`Malformed proposal JSON: ${detail}`],
      warnings,
      proposalPath,
      projectRoot,
      requiresManualReview: false,
    };
  }

  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: formatSchemaIssues(parsed.error),
      warnings,
      proposalPath,
      projectRoot,
      requiresManualReview: false,
    };
  }
  const proposal = parsed.data;

  let target: { path: string; relativePath: string };
  try {
    target = proposal.operation === 'create'
      ? await resolveSafeCreationPath(projectRoot, proposal.file, options.protectedPaths ?? [])
      : await resolveSafeTargetPath(projectRoot, proposal.file, options.protectedPaths ?? []);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      valid: false,
      errors,
      warnings,
      proposalPath,
      projectRoot,
      proposal,
      requiresManualReview: false,
    };
  }

  if (proposal.proposed_content.trim().length === 0) errors.push('Proposed content is empty or whitespace-only.');
  if (proposal.proposed_content.includes('\u0000')) errors.push('Proposed content contains binary NUL bytes.');
  if (Buffer.byteLength(proposal.proposed_content, 'utf8') > MAX_SOURCE_BYTES) errors.push(`Proposed content exceeds ${MAX_SOURCE_BYTES} bytes.`);

  const original = proposal.operation === 'create' ? '' : await readFile(target.path, 'utf8');
  if (proposal.operation === 'modify' && original.includes('\u0000')) errors.push('Target file appears to be binary.');
  if (proposal.operation === 'modify' && proposal.proposed_content === original) errors.push('Proposal is unchanged from the target file.');

  const diff = errors.length === 0
    ? generateDiff(target.relativePath.split(sep).join('/'), original, proposal.proposed_content, options.thresholds)
    : undefined;
  if (diff) warnings.push(...diff.findings);
  warnings.push('The model-provided summary, checks, and risks are untrusted claims and were not used as validation evidence.');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    proposalPath,
    projectRoot,
    targetPath: target.path,
    ...(proposal.operation === 'modify' ? { originalSha256: createHash('sha256').update(original).digest('hex') } : {}),
    proposal,
    diff,
    requiresManualReview: errors.length === 0 && (diff?.suspicious ?? false),
  };
}
