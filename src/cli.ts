import { Codex } from '@openai/codex-sdk';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { proposeLocalChange } from './local-proposal.js';
import { validateProposal, type ValidationReport } from './proposal-validation.js';

const args = process.argv.slice(2);
const command = args[0];
const getArg = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const project = resolve(getArg('--project') ?? '.');
const task = getArg('--task');
const model = process.env.LOCAL_MODEL ?? 'qwen2.5-coder:7b';

const usage = `Usage:
  npm run dev -- plan --project /path/to/repo --task "feature description"
  npm run dev -- local --project /path/to/repo --task "bounded change"
  npm run dev -- local --project /path/to/repo --task "bounded change" --apply
  npm run dev -- propose --project /path/to/repo --file src/example.ts --task "bounded change"
  npm run dev -- validate --project /path/to/repo --proposal .agent-proposals/proposal.json
  npm run dev -- diff --project /path/to/repo --proposal .agent-proposals/proposal.json`;

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

function optionalNumber(name: string): number | undefined {
  const value = getArg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}

function printValidationReport(report: ValidationReport): void {
  console.log(report.valid ? 'VALID: proposal passed structural and safety validation.' : 'INVALID: proposal was rejected.');
  console.log(`Proposal: ${report.proposalPath}`);
  if (report.proposal) console.log(`Target: ${report.proposal.file}`);
  for (const error of report.errors) console.log(`ERROR: ${error}`);
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
  if (report.diff) {
    console.log(`Changes: +${report.diff.addedLines} -${report.diff.removedLines} (${report.diff.changedLines} changed lines)`);
  }
  if (report.requiresManualReview) console.log('REVIEW: Diff findings require manual or supervisor review before any future application step.');
  if (report.valid) {
    console.log('This result establishes structure and filesystem safety only; it does not establish semantic correctness. No source files were modified.');
  }
}

async function main() {
  const taskCommands = ['plan', 'local', 'propose'];
  const proposalCommands = ['validate', 'diff'];
  if (![...taskCommands, ...proposalCommands].includes(command ?? '') || (taskCommands.includes(command ?? '') && !task)) {
    console.log(usage);
    process.exitCode = 1;
    return;
  }
  await checkProject();
  if (proposalCommands.includes(command ?? '')) {
    const proposalPath = getArg('--proposal');
    if (!proposalPath) throw new Error(`${command} requires --proposal <path>`);
    const report = await validateProposal({
      project,
      proposalPath,
      thresholds: {
        changedLines: optionalNumber('--max-changed-lines'),
        changedRatio: optionalNumber('--max-changed-ratio'),
        formattingOnlyLines: optionalNumber('--formatting-only-lines'),
      },
    });
    printValidationReport(report);
    if (!report.valid || !report.diff) {
      process.exitCode = 1;
      return;
    }
    if (command === 'diff') process.stdout.write(`\n${report.diff.unifiedDiff}`);
  } else if (command === 'propose') {
    const file = getArg('--file');
    if (!file) throw new Error('propose requires --file <relative-source-path>');
    await proposeLocalChange({ project, file, task: task!, model });
  } else if (command === 'plan') {
    console.log('Cloud Codex: read-only architecture and task planning.');
    const codex = new Codex();
    const thread = codex.startThread({workingDirectory: project, sandboxMode: 'read-only', approvalPolicy: 'never'});
    const result = await thread.run(`Act as a technical supervisor. Plan but DO NOT edit files. Break this request into ordered, small local-worker tasks. For each include file scope, acceptance criteria, validation commands, risk, and whether cloud review is needed. Do not reveal credentials or secrets. Request: ${task!}`);
    console.log(result.finalResponse);
  } else {
    const apply = args.includes('--apply');
    console.log(`Local Codex via Ollama: ${model}. Mode: ${apply ? 'workspace-write' : 'read-only'}`);
    if (apply && process.env.CONFIRM_LOCAL_EDITS !== 'YES') {
      throw new Error('To allow edits, set CONFIRM_LOCAL_EDITS=YES and run in a disposable branch or Git worktree.');
    }
    const prompt = `${task!}\n\nRules: Stay within this repository. Do not deploy, push, modify secrets, or execute destructive commands. ${apply ? 'Implement only this bounded change and run relevant checks.' : 'Inspect and propose a bounded implementation plan. Do not modify files.'}`;
    await runCLI(['exec', '--oss', '--local-provider', 'ollama', '-m', model, '--sandbox', apply ? 'workspace-write' : 'read-only', prompt]);
  }
}
main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
