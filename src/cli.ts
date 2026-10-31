import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { proposeLocalChange } from './local-proposal.js';
import { validateProposal, type ValidationReport } from './proposal-validation.js';
import { executeProposal, type ExecutionReport } from './proposal-execution.js';
import { coordinateRepair, type RepairReport } from './repair-coordinator.js';
import { createSupervisorPlan } from './supervisor/codex-supervisor.js';
import { reviewLocalRun } from './supervisor/review.js';
import { readPlanArtifact } from './supervisor/artifacts.js';
import { buildRepositoryInventory } from './supervisor/inventory.js';
import { validateAndEnforcePlan } from './supervisor/routing.js';
import type { ImplementationPlan } from './supervisor/schemas.js';

const args = process.argv.slice(2);
const command = args[0];
const getArg = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const project = resolve(getArg('--project') ?? '.');
const task = getArg('--task');
const model = process.env.LOCAL_MODEL ?? 'qwen2.5-coder:7b';
const supervisorCommand = command === 'supervisor' ? args[1] : undefined;

const usage = `Usage:
  npm run dev -- plan --project /path/to/repo --task "feature description" --allow-cloud
  npm run dev -- local --project /path/to/repo --task "bounded change"
  npm run dev -- local --project /path/to/repo --task "bounded change" --apply
  npm run dev -- propose --project /path/to/repo --file src/example.ts --task "bounded change"
  npm run dev -- validate --project /path/to/repo --proposal .agent-proposals/proposal.json
  npm run dev -- diff --project /path/to/repo --proposal .agent-proposals/proposal.json
  npm run dev -- execute --project /path/to/repo --proposal .agent-proposals/proposal.json --apply
  npm run dev -- execute --project /path/to/repo --proposal .agent-proposals/proposal.json --apply --keep-worktree
  npm run dev -- repair --project /path/to/repo --proposal .agent-proposals/proposal.json --apply --max-retries 2
  npm run dev -- repair --project /path/to/repo --proposal .agent-proposals/proposal.json --apply --keep-worktree
  npm run dev -- supervisor plan --project /path/to/repo --task "feature request" --allow-cloud
  npm run dev -- supervisor inspect --project /path/to/repo --plan .agent-runs/plan-supervisor-plan.json
  npm run dev -- supervisor review --project /path/to/repo --report .agent-runs/task-repair.json --allow-cloud`;

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

function printPlan(plan: ImplementationPlan): void {
  console.log(`Plan ${plan.plan_id}: ${plan.summary}`);
  console.log(`Repository context: ${plan.context_status} — ${plan.context_notes}`);
  for (const task of plan.tasks) {
    console.log(`${task.task_id}: ${task.title}`);
    console.log(`  executor=${task.recommended_executor} risk=${task.risk} complexity=${task.complexity} files=${task.file_scope.join(', ')}`);
  }
  for (const finding of plan.routing_policy?.findings ?? []) {
    if (!finding.local_eligible) console.log(`POLICY ${finding.task_id}: ${finding.reasons.join(' ')}`);
  }
}

function cloudAuthorized(): boolean {
  return args.includes('--allow-cloud') || process.env.SUPERVISOR_CLOUD_ENABLED === 'YES';
}

async function runSupervisor(): Promise<void> {
  if (!['plan', 'inspect', 'review'].includes(supervisorCommand ?? '')) throw new Error('supervisor requires plan, inspect, or review');
  if (supervisorCommand === 'inspect') {
    const planPath = getArg('--plan');
    if (!planPath) throw new Error('supervisor inspect requires --plan <path>');
    const artifact = await readPlanArtifact(project, planPath);
    const request = typeof artifact === 'object' && artifact !== null && 'request' in artifact && typeof artifact.request === 'string'
      ? artifact.request
      : '';
    const inventory = await buildRepositoryInventory(project, { request });
    const plan = await validateAndEnforcePlan(artifact, { projectRoot: project, maxTasks: optionalInteger('--max-tasks') ?? 8, inventory });
    printPlan(plan);
    console.log('Inspection was local and read-only; no Cloud Codex call was made.');
    return;
  }
  if (!cloudAuthorized()) throw new Error('Cloud supervisor calls require --allow-cloud or SUPERVISOR_CLOUD_ENABLED=YES.');
  if (supervisorCommand === 'plan') {
    if (!task) throw new Error('supervisor plan requires --task <feature-request>');
    const result = await createSupervisorPlan({
      project,
      request: task,
      maxTasks: optionalInteger('--max-tasks'),
      maxCloudCalls: optionalInteger('--max-cloud-calls'),
      model: getArg('--cloud-model'),
      cloudAuthorized: true,
    });
    printPlan(result.plan);
    console.log(`Saved plan: ${result.planPath}`);
    console.log(`Saved cloud usage: ${result.usagePath}`);
    return;
  }
  const reportPath = getArg('--report');
  if (!reportPath) throw new Error('supervisor review requires --report <path>');
  const result = await reviewLocalRun({
    project,
    reportPath,
    maxCloudCalls: optionalInteger('--max-cloud-calls'),
    model: getArg('--cloud-model'),
    cloudAuthorized: true,
  });
  console.log(`Verdict: ${result.review.verdict}`);
  for (const finding of result.review.findings) console.log(`${finding.severity.toUpperCase()} ${finding.category}: ${finding.summary}`);
  console.log(`Next action: ${result.review.proposed_next_action}`);
  console.log('Human approval remains required. No patch was applied.');
  console.log(`Saved review: ${result.reviewPath}`);
  console.log(`Saved cloud usage: ${result.usagePath}`);
}

async function main() {
  const taskCommands = ['plan', 'local', 'propose'];
  const proposalCommands = ['validate', 'diff'];
  const supportedCommands = [...taskCommands, ...proposalCommands, 'execute', 'repair', 'supervisor'];
  if (!supportedCommands.includes(command ?? '') || (taskCommands.includes(command ?? '') && !task)) {
    console.log(usage);
    process.exitCode = 1;
    return;
  }
  await checkProject();
  if (command === 'supervisor') {
    await runSupervisor();
  } else if (command === 'repair') {
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
    if (!cloudAuthorized()) throw new Error('The legacy plan command now requires --allow-cloud or SUPERVISOR_CLOUD_ENABLED=YES.');
    const result = await createSupervisorPlan({
      project,
      request: task!,
      maxTasks: optionalInteger('--max-tasks'),
      maxCloudCalls: optionalInteger('--max-cloud-calls'),
      model: getArg('--cloud-model'),
      cloudAuthorized: true,
    });
    printPlan(result.plan);
    console.log(`Saved plan: ${result.planPath}`);
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
