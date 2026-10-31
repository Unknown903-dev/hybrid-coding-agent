import { Codex } from '@openai/codex-sdk';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { proposeLocalChange } from './local-proposal.js';
import { validateProposal, type ValidationReport } from './proposal-validation.js';
import { executeProposal, type ExecutionReport } from './proposal-execution.js';
import { coordinateRepair, type RepairReport } from './repair-coordinator.js';

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
  npm run dev -- diff --project /path/to/repo --proposal .agent-proposals/proposal.json
  npm run dev -- execute --project /path/to/repo --proposal .agent-proposals/proposal.json --apply
  npm run dev -- execute --project /path/to/repo --proposal .agent-proposals/proposal.json --apply --keep-worktree
  npm run dev -- repair --project /path/to/repo --proposal .agent-proposals/proposal.json --apply --max-retries 2
  npm run dev -- repair --project /path/to/repo --proposal .agent-proposals/proposal.json --apply --keep-worktree`;

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

function optionalInteger(name: string): number | undefined {
  const value = optionalNumber(name);
  if (value !== undefined && !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
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

function printExecutionReport(report: ExecutionReport): void {
  console.log(report.status === 'passed' ? 'EXECUTION PASSED: all configured trusted checks passed.' : 'EXECUTION FAILED.');
  console.log(`Task ID: ${report.task_id}`);
  if (report.worktree.location) {
    console.log(`Worktree: ${report.worktree.location} (${report.worktree.preserved ? 'preserved' : 'cleaned'})`);
  }
  console.log(`Structural validation: ${report.structural_validation.status}`);
  console.log(`Application: ${report.application.status}${report.application.stale ? ' (stale proposal)' : ''}`);
  console.log(`Automated checks: ${report.checks.status}`);
  for (const check of report.checks.results) {
    console.log(`CHECK ${check.status.toUpperCase()}: ${check.name} (exit ${check.exit_code ?? 'none'}, ${check.duration_ms} ms${check.timed_out ? ', timed out' : ''})`);
  }
  for (const error of report.errors) console.log(`ERROR: ${error}`);
  console.log('Human review: required; automated checks do not authorize merge, commit, push, or deployment.');
  if (report.report_path) console.log(`Report: ${report.report_path}`);
}

function printRepairReport(report: RepairReport): void {
  console.log(report.status === 'passed' ? 'REPAIR PASSED: all trusted checks passed.' : 'REPAIR FAILED.');
  console.log(`Task ID: ${report.task_id}`);
  console.log(`Stop reason: ${report.stop_reason}`);
  console.log(`Repair attempts: ${report.repair_attempts_used}/${report.max_repair_attempts}`);
  console.log(`Proposal validity: ${report.proposal_validity}`);
  console.log(`Automated checks: ${report.automated_checks}`);
  for (const attempt of report.attempts) {
    console.log(`ATTEMPT ${attempt.attempt}: ${attempt.kind}, proposal ${attempt.proposal_valid ? 'valid' : 'invalid'}, checks ${attempt.checks_status}`);
  }
  if (report.worktree.location) {
    console.log(`Worktree: ${report.worktree.location} (${report.worktree.preserved ? 'preserved' : 'cleaned'})`);
  }
  if (report.final_patch_path) console.log(`Patch: ${report.final_patch_path}`);
  for (const error of report.errors) console.log(`ERROR: ${error}`);
  console.log(`Cloud escalation recommended: ${report.cloud_escalation_recommended ? 'yes' : 'no'}`);
  console.log('Semantic review: required; passing checks does not guarantee task correctness.');
  if (report.report_path) console.log(`Report: ${report.report_path}`);
}

async function main() {
  const taskCommands = ['plan', 'local', 'propose'];
  const proposalCommands = ['validate', 'diff'];
  const supportedCommands = [...taskCommands, ...proposalCommands, 'execute', 'repair'];
  if (!supportedCommands.includes(command ?? '') || (taskCommands.includes(command ?? '') && !task)) {
    console.log(usage);
    process.exitCode = 1;
    return;
  }
  await checkProject();
  if (command === 'repair') {
    const proposalPath = getArg('--proposal');
    if (!proposalPath) throw new Error('repair requires --proposal <path>');
    if (!args.includes('--apply')) throw new Error('repair requires explicit authorization with --apply');
    const preview = await validateProposal({ project, proposalPath });
    if (preview.proposal) console.log(`Proposal summary: ${preview.proposal.summary}`);
    const report = await coordinateRepair({
      project,
      proposalPath,
      apply: true,
      keepWorktree: args.includes('--keep-worktree'),
      maxRetries: optionalInteger('--max-retries'),
      totalTimeBudgetMs: optionalInteger('--time-budget-ms'),
    });
    printRepairReport(report);
    if (report.status !== 'passed') process.exitCode = 1;
  } else if (command === 'execute') {
    const proposalPath = getArg('--proposal');
    if (!proposalPath) throw new Error('execute requires --proposal <path>');
    if (!args.includes('--apply')) throw new Error('execute requires explicit authorization with --apply');
    const preview = await validateProposal({ project, proposalPath });
    if (preview.proposal) console.log(`Proposal summary: ${preview.proposal.summary}`);
    const report = await executeProposal({
      project,
      proposalPath,
      apply: true,
      keepWorktree: args.includes('--keep-worktree'),
    });
    printExecutionReport(report);
    if (report.status !== 'passed') process.exitCode = 1;
  } else if (proposalCommands.includes(command ?? '')) {
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
