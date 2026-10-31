import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import { sanitizeCloudText } from './artifacts.js';

const execFileAsync = promisify(execFile);
const EXCLUDED_SEGMENTS = new Set([
  '.git', '.agent-runs', '.agent-proposals', '.agent-worktrees', '.aws', '.ssh', '.codex',
  'node_modules', 'dist', 'build', 'coverage',
]);
const EXCLUDED_FILES = new Set([
  '.env', '.netrc', '.npmrc', '.pypirc', 'credentials.json', 'secrets.json', 'service-account.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.agent-validation.json',
]);
const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.json', '.kt', '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx',
  '.vue', '.yaml', '.yml',
]);

export interface RepositoryInventoryEntry {
  path: string;
  size_bytes: number;
  content_excerpt?: string;
  content_truncated?: boolean;
}

export interface RepositoryInventory {
  files: RepositoryInventoryEntry[];
  verified_file_count: number;
  excluded_file_count: number;
  inventory_truncated: boolean;
  content_characters: number;
  limits: {
    max_files: number;
    max_candidates: number;
    max_path_characters: number;
    max_content_characters: number;
    max_content_per_file: number;
    max_file_bytes: number;
  };
}

export interface RepositoryInventoryOptions {
  request?: string;
  maxFiles?: number;
  maxCandidates?: number;
  maxPathCharacters?: number;
  maxContentCharacters?: number;
  maxContentPerFile?: number;
  maxFileBytes?: number;
}

export class RepositoryInventoryError extends Error {}

function safeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split('/');
  const name = (segments.at(-1) ?? '').toLowerCase();
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) return false;
  return !EXCLUDED_FILES.has(name) && !name.startsWith('.env.') && !/\.(?:pem|key|p12|pfx)$/i.test(name);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function requestTerms(request: string): Set<string> {
  return new Set(request.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []);
}

function relevance(path: string, terms: Set<string>): number {
  const normalized = path.toLowerCase();
  let score = SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) ? 10 : 0;
  if (/\.(?:test|spec)\.[^.]+$/i.test(path)) score -= 1;
  for (const term of terms) if (normalized.includes(term)) score += 20;
  return score;
}

async function gitFiles(projectRoot: string): Promise<string[]> {
  try {
    const result = await execFileAsync('git', [
      '-c', 'core.quotepath=false', '-C', projectRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
    ], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return result.stdout.split('\0').filter(Boolean);
  } catch (error) {
    throw new RepositoryInventoryError(`Unable to build verified Git file inventory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function buildRepositoryInventory(
  project: string,
  options: RepositoryInventoryOptions = {},
): Promise<RepositoryInventory> {
  const limits = {
    maxFiles: options.maxFiles ?? 200,
    maxCandidates: options.maxCandidates ?? 10_000,
    maxPathCharacters: options.maxPathCharacters ?? 20_000,
    maxContentCharacters: options.maxContentCharacters ?? 30_000,
    maxContentPerFile: options.maxContentPerFile ?? 4_000,
    maxFileBytes: options.maxFileBytes ?? 40_000,
  };
  if (Object.values(limits).some(value => !Number.isInteger(value) || value < 1)) {
    throw new RepositoryInventoryError('Repository inventory limits must be positive integers.');
  }

  const projectRoot = await realpath(project).catch(error => {
    throw new RepositoryInventoryError(`Unable to access repository: ${error instanceof Error ? error.message : String(error)}`);
  });
  const candidates = await gitFiles(projectRoot);
  const terms = requestTerms(options.request ?? '');
  candidates.sort((a, b) => relevance(b, terms) - relevance(a, terms) || a.localeCompare(b));
  const candidateInventoryTruncated = candidates.length > limits.maxCandidates;
  const verified: Array<{ path: string; size: number }> = [];
  let excluded = 0;
  for (const path of candidates.slice(0, limits.maxCandidates)) {
    if (!safeRelativePath(path)) {
      excluded += 1;
      continue;
    }
    try {
      const lexical = resolve(projectRoot, path);
      if (!within(projectRoot, lexical)) throw new Error('escape');
      const stat = await lstat(lexical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.maxFileBytes) throw new Error('not eligible');
      const actual = await realpath(lexical);
      if (!within(projectRoot, actual)) throw new Error('escape');
      verified.push({ path, size: stat.size });
    } catch {
      excluded += 1;
    }
  }

  verified.sort((a, b) => relevance(b.path, terms) - relevance(a.path, terms) || a.path.localeCompare(b.path));
  const selected: Array<{ path: string; size: number }> = [];
  let pathCharacters = 0;
  for (const file of verified) {
    if (selected.length >= limits.maxFiles || pathCharacters + file.path.length > limits.maxPathCharacters) break;
    selected.push(file);
    pathCharacters += file.path.length;
  }
  if (selected.length === 0) {
    throw new RepositoryInventoryError('No safe existing repository files could be verified; supervisor planning has insufficient context.');
  }

  const files: RepositoryInventoryEntry[] = [];
  let contentCharacters = 0;
  for (const file of selected) {
    const entry: RepositoryInventoryEntry = { path: file.path, size_bytes: file.size };
    if (SOURCE_EXTENSIONS.has(extname(file.path).toLowerCase()) && contentCharacters < limits.maxContentCharacters) {
      const remaining = Math.min(limits.maxContentPerFile, limits.maxContentCharacters - contentCharacters);
      const raw = await readFile(resolve(projectRoot, file.path));
      if (!raw.subarray(0, Math.min(raw.length, 8_192)).includes(0)) {
        const decoded = raw.toString('utf8');
        const excerpt = sanitizeCloudText(decoded, remaining).slice(0, remaining);
        entry.content_excerpt = excerpt;
        entry.content_truncated = decoded.length > excerpt.length;
        contentCharacters += excerpt.length;
      }
    }
    files.push(entry);
  }

  return {
    files,
    verified_file_count: verified.length,
    excluded_file_count: excluded,
    inventory_truncated: candidateInventoryTruncated || selected.length < verified.length,
    content_characters: contentCharacters,
    limits: {
      max_files: limits.maxFiles,
      max_candidates: limits.maxCandidates,
      max_path_characters: limits.maxPathCharacters,
      max_content_characters: limits.maxContentCharacters,
      max_content_per_file: limits.maxContentPerFile,
      max_file_bytes: limits.maxFileBytes,
    },
  };
}

export function inventoryPaths(inventory: RepositoryInventory): ReadonlySet<string> {
  return new Set(inventory.files.map(file => file.path));
}

export function formatInventoryForPrompt(inventory: RepositoryInventory): string {
  const escapeMarkup = (value: unknown): string => JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
  const selectable = inventory.files.map(file => ({ path: file.path, size_bytes: file.size_bytes }));
  const sources = inventory.files
    .filter(file => file.content_excerpt !== undefined)
    .map(file => ({ path: file.path, content_excerpt: file.content_excerpt, content_truncated: file.content_truncated === true }));
  return [
    `verified=${inventory.verified_file_count} selectable=${inventory.files.length} excluded=${inventory.excluded_file_count} truncated=${inventory.inventory_truncated}`,
    '<selectable_existing_files>',
    escapeMarkup(selectable),
    '</selectable_existing_files>',
    '<untrusted_source_excerpts>',
    escapeMarkup(sources),
    '</untrusted_source_excerpts>',
  ].join('\n');
}
