import { readFile, realpath, mkdir, writeFile, lstat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep, join, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { formatSchemaIssues, modelProposalFieldsSchema } from './proposal-schema.js';
import { resolveSafeCreationPath } from './proposal-validation.js';

const MAX_FILE_BYTES = 40_000;
const BLOCKED = new Set(['.env', '.git', '.agent-state', 'node_modules', '.ssh', '.aws', '.codex', 'dist', 'build', 'coverage']);

export interface LocalProposalRequest {
  operation: 'modify' | 'create';
  task: string;
  file: string;
  model: string;
  originalContent: string;
  timeoutMs: number;
}

export interface LocalProposalAdapter {
  requestProposal(request: LocalProposalRequest): Promise<unknown>;
}

export class OllamaProposalAdapter implements LocalProposalAdapter {
  async requestProposal(request: LocalProposalRequest): Promise<unknown> {
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
          { role: 'system', content: `You are a cautious coding assistant producing an untrusted code proposal.
Respond with one JSON object containing exactly these keys: summary (non-empty string), proposed_content (string), checks (array of non-empty strings), risks (array of non-empty strings).
Rules:
- Modify only code directly required by the assigned task.
- Preserve existing behavior, imports, exports, and public interfaces unless the task explicitly requires changing them.
- Avoid unrelated cleanup, comments, renaming, and formatting changes.
- proposed_content must contain the COMPLETE file text, never a patch or markdown fence.
- Never claim a test, typecheck, lint, or command passed: you are not given execution results. State that checks were not run when relevant.
- For modify operations, if no meaningful improvement is needed, return the original content unchanged and say so in summary.
- For create operations, produce complete initial content for exactly the declared new file; never suggest creating directories or other files.
- Do not invent other files, commands to execute, tool calls, validation results, or facts about the repository.` },
          { role: 'user', content: `Operation: ${request.operation}\nTask: ${request.task}\nTarget file: ${request.file}\n${request.operation === 'create' ? 'The target is verified absent. Produce its complete initial content.' : `Original file content:\n${request.originalContent}`}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const data = await response.json() as { message?: { content?: string } };
    const raw = data.message?.content;
    if (!raw) throw new Error('Ollama returned an empty message.');
    return raw;
  }
}

function isBlocked(rel: string): boolean {
  const segments = rel.split(sep);
  return segments.some(segment => {
    const normalized = segment.toLowerCase();
    return BLOCKED.has(normalized) || normalized.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(normalized);
  });
}

export async function ensureProposalDirectory(projectRoot: string): Promise<string> {
  const proposalDir = join(projectRoot, '.agent-proposals');
  await mkdir(proposalDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(proposalDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('.agent-proposals must be a regular non-symlink directory.');
  const actual = await realpath(proposalDir);
  const rel = relative(projectRoot, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('.agent-proposals escapes the target repository.');
  return actual;
}

export async function proposeLocalChange(options: {
  project: string;
  file: string;
  task: string;
  model: string;
  operation?: 'modify' | 'create';
  timeoutMs?: number;
  adapter?: LocalProposalAdapter;
}): Promise<string> {
  const projectRoot = await realpath(options.project);
  const operation = options.operation ?? 'modify';
  if (isAbsolute(options.file) || win32.isAbsolute(options.file) || options.file.split(/[\\/]/).includes('..')) {
    throw new Error('File must be a repository-relative source path without traversal.');
  }
  const targetPath = resolve(projectRoot, options.file);
  const lexicalRelative = relative(projectRoot, targetPath);
  if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`)) {
    throw new Error('File must be a safe source file inside the project.');
  }
  let rel: string;
  let content: string;
  if (operation === 'create') {
    const target = await resolveSafeCreationPath(projectRoot, options.file);
    rel = target.relativePath;
    content = '';
  } else {
    const targetRealPath = await realpath(targetPath);
    rel = relative(projectRoot, targetRealPath);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(projectRoot, rel) !== targetRealPath || isBlocked(rel)) {
      throw new Error('File must be a safe source file inside the project (secrets and symlinks outside the project are blocked).');
    }
    const stat = await lstat(targetRealPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Only regular files up to ${MAX_FILE_BYTES} bytes are supported.`);
    content = await readFile(targetRealPath, 'utf8');
  }
  if (content.includes('\u0000')) throw new Error('Binary files are not supported.');

  const raw = await (options.adapter ?? new OllamaProposalAdapter()).requestProposal({
    operation,
    task: options.task,
    file: rel,
    model: options.model,
    originalContent: content,
    timeoutMs: options.timeoutMs ?? 180_000,
  });
  let modelOutput: unknown = raw;
  if (typeof raw === 'string') {
    try {
      modelOutput = JSON.parse(raw);
    } catch (error) {
      throw new Error(`The model returned malformed proposal JSON: ${error instanceof Error ? error.message : String(error)}. Source files were not modified.`);
    }
  }
  const parsed = modelProposalFieldsSchema.safeParse(modelOutput);
  if (!parsed.success) {
    throw new Error(`The model did not return the required proposal fields: ${formatSchemaIssues(parsed.error).join('; ')}. Source files were not modified.`);
  }
  const p = parsed.data;
  const proposalDir = await ensureProposalDirectory(projectRoot);
  const outputFile = join(proposalDir, `${Date.now()}-${randomUUID()}.json`);
  const resultingSha256 = createHash('sha256').update(p.proposed_content).digest('hex');
  await writeFile(outputFile, JSON.stringify({ operation, task: options.task, file: rel, model: options.model, summary: p.summary,
    proposed_content: p.proposed_content, checks: p.checks, risks: p.risks,
    ...(operation === 'modify' ? { original_sha256: createHash('sha256').update(content).digest('hex') } : {
      expected_absent: true, resulting_sha256: resultingSha256,
    }) }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Proposal for ${basename(rel)}: ${p.summary}`);
  console.log(`Saved proposal to ${outputFile}`);
  console.log('No source files were modified. Review this proposal before implementing it.');
  return outputFile;
}
