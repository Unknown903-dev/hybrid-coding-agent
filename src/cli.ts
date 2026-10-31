import { Codex } from '@openai/codex-sdk';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';

const args = process.argv.slice(2);
const command = args[0];
const getArg = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const project = resolve(getArg('--project') ?? '.');
const task = getArg('--task');
const model = process.env.LOCAL_MODEL ?? 'qwen2.5-coder:7b';

async function checkProject() {
  await access(resolve(project, '.git')).catch(() => { throw new Error(`Not a Git repository: ${project}`); });
}

async function runCLI(cliArgs: string[]) {
  await new Promise<void>((done, reject) => {
    const child = spawn('codex', cliArgs, { cwd: project, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', code => code === 0 ? done() : reject(new Error(`Codex exited: ${code}`)));
  });
}

async function main() {
  if (!['plan', 'local'].includes(command ?? '') || !task) {
    console.log('Usage:\n  npm run dev -- plan --project /path/to/repo --task "feature description"\n  npm run dev -- local --project /path/to/repo --task "bounded change"\n  npm run dev -- local --project /path/to/repo --task "bounded change" --apply');
    process.exitCode = 1;
    return;
  }
  await checkProject();
  if (command === 'plan') {
    console.log('Cloud Codex: read-only architecture and task planning.');
    const codex = new Codex();
    const thread = codex.startThread({workingDirectory: project, sandboxMode: 'read-only', approvalPolicy: 'never'});
    const result = await thread.run(`Act as a technical supervisor. Plan but DO NOT edit files. Break this request into ordered, small local-worker tasks. For each include file scope, acceptance criteria, validation commands, risk, and whether cloud review is needed. Do not reveal credentials or secrets. Request: ${task}`);
    console.log(result.finalResponse);
  } else {
    const apply = args.includes('--apply');
    console.log(`Local Codex via Ollama: ${model}. Mode: ${apply ? 'workspace-write' : 'read-only'}`);
    if (apply && process.env.CONFIRM_LOCAL_EDITS !== 'YES') {
      throw new Error('To allow edits, set CONFIRM_LOCAL_EDITS=YES and run in a disposable branch or Git worktree.');
    }
    const prompt = `${task}\n\nRules: Stay within this repository. Do not deploy, push, modify secrets, or execute destructive commands. ${apply ? 'Implement only this bounded change and run relevant checks.' : 'Inspect and propose a bounded implementation plan. Do not modify files.'}`;
    await runCLI(['exec', '--oss', '--local-provider', 'ollama', '-m', model, '--sandbox', apply ? 'workspace-write' : 'read-only', prompt]);
  }
}
main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
