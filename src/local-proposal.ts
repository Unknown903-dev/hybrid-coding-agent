import { readFile, realpath, mkdir, writeFile, lstat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { formatSchemaIssues, proposalSchema } from './proposal-schema.js';

const MAX_FILE_BYTES = 40_000;
const BLOCKED = new Set(['.env', '.git', 'node_modules', '.ssh', '.aws', '.codex', 'dist', 'build', 'coverage']);

function isBlocked(rel: string): boolean {
  const segments = rel.split(sep);
  return segments.some(segment => BLOCKED.has(segment) || segment.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(segment));
}

export async function proposeLocalChange(options: {
  project: string;
  file: string;
  task: string;
  model: string;
}): Promise<string> {
  const projectRoot = await realpath(options.project);
  if (isAbsolute(options.file) || win32.isAbsolute(options.file) || options.file.split(/[\\/]/).includes('..')) {
    throw new Error('File must be a repository-relative source path without traversal.');
  }
  const targetPath = resolve(projectRoot, options.file);
  const lexicalRelative = relative(projectRoot, targetPath);
  if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`)) {
    throw new Error('File must be a safe source file inside the project.');
  }
  const targetRealPath = await realpath(targetPath);
  const rel = relative(projectRoot, targetRealPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(projectRoot, rel) !== targetRealPath || isBlocked(rel)) {
    throw new Error('File must be a safe source file inside the project (secrets and symlinks outside the project are blocked).');
  }
  const stat = await lstat(targetRealPath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error(`Only regular files up to ${MAX_FILE_BYTES} bytes are supported.`);
  }
  const content = await readFile(targetRealPath, 'utf8');
  if (content.includes('\u0000')) throw new Error('Binary files are not supported.');

  const endpoint = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const response = await fetch(new URL('/api/chat', endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: options.model,
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
- If no meaningful improvement is needed, return the original content unchanged and say so in summary; validation will record this as a deliberate no-change result.
- Do not invent other files, commands to execute, tool calls, validation results, or facts about the repository.` },
        { role: 'user', content: `Task: ${options.task}\nTarget file: ${rel}\nOriginal file content:\n${content}` }
      ]
    })
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const data = await response.json() as { message?: { content?: string } };
  const raw = data.message?.content;
  if (!raw) throw new Error('Ollama returned an empty message.');
  const modelOutput: unknown = JSON.parse(raw);
  const parsed = proposalSchema.pick({ summary: true, proposed_content: true, checks: true, risks: true }).strict().safeParse(modelOutput);
  if (!parsed.success) {
    throw new Error(`The model did not return the required proposal fields: ${formatSchemaIssues(parsed.error).join('; ')}. Source files were not modified.`);
  }
  const p = parsed.data;
  const proposalDir = join(projectRoot, '.agent-proposals');
  await mkdir(proposalDir, { recursive: true });
  const outputFile = join(proposalDir, `${Date.now()}-${randomUUID()}.json`);
  await writeFile(outputFile, JSON.stringify({ task: options.task, file: rel, model: options.model, summary: p.summary,
    proposed_content: p.proposed_content, checks: p.checks, risks: p.risks }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Proposal for ${basename(rel)}: ${p.summary}`);
  console.log(`Saved proposal to ${outputFile}`);
  console.log('No source files were modified. Review this proposal before implementing it.');
  return outputFile;
}
