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
import { runOrchestration } from './orchestration/run-coordinator.js';
import type { OrchestrationReport } from './orchestration/schemas.js';
import { approveOrchestrationRun, inspectOrchestrationRun, integrateApprovedRun, type RunInspection } from './orchestration/integration.js';
import { runMultiTaskOrchestration } from './orchestration/multi-run-coordinator.js';

const args = process.argv.slice(2);
const command = args[0];
const getArg = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const project = resolve(getArg('--project') ?? '.');
const task = getArg('--task');
const model = getArg('--model') ?? process.env.LOCAL_MODEL ?? 'qwen2.5-coder:7b';
const supervisorCommand = command === 'supervisor' ? args[1] : undefined;
const runSubcommand = command === 'run' && ['inspect', 'approve', 'integrate'].includes(args[1] ?? '') ? args[1] : undefined;

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
  npm run dev -- run --project /path/to/repo --task "bounded change" --allow-cloud --apply
  npm run dev -- run --project /path/to/repo --task "bounded change" --allow-cloud --dry-run
  npm run dev -- run --project /path/to/repo --task "several independent changes" --multi-task --max-tasks 3 --allow-cloud --apply
  npm run dev -- run inspect --project /path/to/repo --run-id <run-id>
  npm run dev -- run approve --project /path/to/repo --run-id <run-id> --yes
  npm run dev -- run integrate --project /path/to/repo --run-id <run-id>
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

function printOrchestrationReport(report: OrchestrationReport, path: string): void {
  console.log(`Orchestration state: ${report.state}`);
  console.log(`Run ID: ${report.run_id}`);
  if (report.selected_task) console.log(`Selected task: ${report.selected_task.task_id} (${report.selected_task.file_scope.join(', ')})`);
  for (const selected of report.selected_tasks ?? []) console.log(`Selected task: ${selected.task_id} (${selected.file_scope.join(', ')})`);
  for (const result of report.task_results ?? []) {
    console.log(`TASK ${result.order} ${result.task_id}: ${result.status}, proposal ${result.proposal_validation}, checks ${result.automated_checks}, repairs ${result.repair_attempts}`);
  }
  console.log(`Plan validation: ${report.validation.plan}`);
  console.log(`Proposal validation: ${report.validation.proposal}`);
  console.log(`Automated checks: ${report.validation.automated_checks}`);
  console.log(`Cloud calls: ${report.cloud_usage.calls_started}/${report.cloud_usage.call_budget}`);
  console.log(`Cloud review: ${report.final_review.status}${report.final_review.verdict ? ` (${report.final_review.verdict})` : ''}`);
  if (report.final_patch_path) console.log(`Reviewable patch: ${report.final_patch_path}`);
  if (report.final_patch_sha256) console.log(`Combined patch SHA-256: ${report.final_patch_sha256}`);
  if (report.worktree) console.log(`Worktree: ${report.worktree.location} (${report.worktree.preserved ? 'preserved' : report.worktree.cleaned ? 'cleaned' : 'active'})`);
  if (report.human_approval_status) console.log(`Human approval status: ${report.human_approval_status}`);
  if (report.failure_reason) console.log(`STATUS DETAIL: ${report.failure_reason}`);
  console.log('Human approval: required. No commit, merge, push, deployment, or original-tree source write was performed.');
  console.log(`Orchestration report: ${path}`);
}

function printRunInspection(inspection: RunInspection): void {
  console.log(`Run ID: ${inspection.runId}`);
  console.log(`Original task: ${inspection.task}`);
  console.log(`Changed files: ${inspection.changedFiles.join(', ')}`);
  console.log(`Diff summary: +${inspection.diffSummary.addedLines} -${inspection.diffSummary.removedLines} (${inspection.diffSummary.changedLines} changed lines)`);
  console.log(`Patch SHA-256: ${inspection.diffSummary.patchSha256}`);
  console.log(`Automated validation: plan=${inspection.automatedValidation.plan}, proposal=${inspection.automatedValidation.proposal}, checks=${inspection.automatedValidation.automated_checks}`);
  console.log(`Cloud review: ${inspection.cloudReviewVerdict ?? 'unavailable'}`);
  console.log(`Cloud usage: ${inspection.cloudUsage.calls_started}/${inspection.cloudUsage.call_budget} calls started; token usage ${inspection.cloudUsage.token_usage ? JSON.stringify(inspection.cloudUsage.token_usage) : 'unknown'}`);
  for (const warning of inspection.warnings) console.log(`WARNING: ${warning}`);
  for (const reason of inspection.ineligibilityReasons) console.log(`INELIGIBLE: ${reason}`);
  console.log(`Eligible for approval: ${inspection.eligibleForApproval ? 'yes' : 'no'}`);
  process.stdout.write(`\n${inspection.patch}${inspection.patch.endsWith('\n') ? '' : '\n'}`);
}

async function confirmApproval(runId: string, patchSha256: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Approve run ${runId}, patch ${patchSha256}? Type "approve": `);
    return answer.trim() === 'approve';
  } finally {
    prompt.close();
  }
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
  const supportedCommands = [...taskCommands, ...proposalCommands, 'execute', 'repair', 'run', 'supervisor'];
  if (!supportedCommands.includes(command ?? '') || ((taskCommands.includes(command ?? '') || (command === 'run' && !runSubcommand)) && !task)) {
    console.log(usage);
    process.exitCode = 1;
    return;
  }
  await checkProject();
  if (command === 'run') {
    if (runSubcommand) {
      const runId = getArg('--run-id');
      if (!runId) throw new Error(`run ${runSubcommand} requires --run-id <run-id>`);
      if (runSubcommand === 'inspect') {
        printRunInspection(await inspectOrchestrationRun(project, runId));
      } else if (runSubcommand === 'approve') {
        const inspection = await inspectOrchestrationRun(project, runId);
        printRunInspection(inspection);
        if (!inspection.eligibleForApproval) throw new Error('This run is not eligible for approval.');
        const explicit = args.includes('--yes');
        const authorized = explicit || await confirmApproval(runId, inspection.diffSummary.patchSha256);
        const approved = await approveOrchestrationRun({
          project, runId, authorized,
          authorizationMethod: explicit ? 'explicit_flag' : 'interactive_confirmation',
        });
        console.log(`Approved exact patch ${approved.record.patch_sha256}`);
        console.log(`Approval record: ${approved.approvalPath}`);
        console.log('No source files were modified. Approval is not proof of semantic correctness.');
      } else {
        const integrated = await integrateApprovedRun({ project, runId });
        console.log(`Integrated approved patch ${integrated.audit.patch_sha256} into the working tree.`);
        console.log(`Changed files: ${integrated.audit.changed_files.join(', ')}`);
        console.log(`Integration audit: ${integrated.auditPath}`);
        console.log('No commit, push, merge, or deployment was performed. Review the working-tree diff before committing.');
      }
    } else {
      const sharedOptions = {
        project,
        request: task!,
        apply: args.includes('--apply'),
        cloudAuthorized: cloudAuthorized(),
        dryRun: args.includes('--dry-run'),
        localModel: model,
        cloudModel: getArg('--cloud-model'),
        maxRetries: optionalInteger('--max-retries'),
        maxCloudCalls: optionalInteger('--max-cloud-calls'),
        keepWorktree: args.includes('--keep-worktree'),
      };
      const result = args.includes('--multi-task')
        ? await runMultiTaskOrchestration({ ...sharedOptions, maxTasks: optionalInteger('--max-tasks') })
        : await runOrchestration(sharedOptions);
      printOrchestrationReport(result.report, result.reportPath);
      const successfulDryRun = result.report.dry_run && result.report.state === 'awaiting_human_review';
      const successfulRun = result.report.validation.automated_checks === 'passed' &&
        result.report.final_review.status === 'completed' && result.report.final_review.verdict === 'ready_for_human_review';
      if (!successfulDryRun && !successfulRun) process.exitCode = 1;
    }
  } else if (command === 'supervisor') {
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
