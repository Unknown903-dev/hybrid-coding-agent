import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositoryInventory } from './inventory.js';
import { implementationPlanSchema, type ImplementationPlan, type PlanTask, type RoutingFinding } from './schemas.js';
import { DependencyGraphError, orderTasksByDependencies } from './dependency-graph.js';
import { resolveSafeCreationPath } from '../proposal-validation.js';

const HIGH_RISK_TAGS = new Set([
  'security', 'authentication', 'authorization', 'billing', 'migration',
  'deployment', 'infrastructure', 'data_loss', 'public_api',
]);
const HIGH_RISK_PATTERN = /\b(security|auth(?:entication|orization)?|billing|payment|migration|deploy(?:ment)?|infrastructure|credential|secret|permission|production)\b/i;
const PROTECTED_SEGMENTS = new Set(['.git', '.agent-runs', '.agent-proposals', '.agent-worktrees', '.agent-state', '.env', 'node_modules', '.aws', '.ssh', '.codex']);
const PROTECTED_FILES = new Set([
  '.env', '.netrc', '.npmrc', '.pypirc', 'credentials.json', 'secrets.json', 'service-account.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.agent-validation.json',
]);

export class PlanValidationError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Invalid supervisor plan: ${reasons.join('; ')}`);
  }
}

function safeScope(path: string): boolean {
  if (isAbsolute(path)) return false;
  const segments = path.replaceAll('\\', '/').split('/');
  const name = (segments.at(-1) ?? '').toLowerCase();
  if (PROTECTED_FILES.has(name) || /\.(?:pem|key|p12|pfx)$/i.test(name)) return false;
  return !segments.some(segment => {
    const normalized = segment.toLowerCase();
    return !normalized || normalized === '.' || normalized === '..' || PROTECTED_SEGMENTS.has(normalized) || normalized.startsWith('.env.');
  });
}

async function existingSafeFile(projectRoot: string | undefined, path: string): Promise<boolean> {
  if (!projectRoot) return true;
  try {
    const candidate = resolve(projectRoot, path);
    const rel = relative(projectRoot, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const actual = await realpath(candidate);
    const actualRel = relative(projectRoot, actual);
    return actualRel !== '..' && !actualRel.startsWith(`..${sep}`) && !isAbsolute(actualRel);
  } catch {
    return false;
  }
}

async function routeTask(task: PlanTask, projectRoot?: string): Promise<RoutingFinding> {
  const reasons: string[] = [];
  const text = `${task.title} ${task.description} ${task.routing_explanation}`;
  const highRisk = task.risk === 'high' || task.risk_tags.some(tag => HIGH_RISK_TAGS.has(tag)) || HIGH_RISK_PATTERN.test(text);
  if (highRisk) reasons.push('High-risk domain requires cloud or human handling.');
  if (task.complexity === 'complex') reasons.push('Complex tasks are outside the current local-worker boundary.');
  if (task.file_scope.length !== 1) reasons.push('The local worker supports exactly one file per task.');
  if (task.operation === 'delete') reasons.push('The local worker cannot delete files.');
  if (task.file_scope.some(path => !safeScope(path))) reasons.push('File scope contains a protected or unsafe path.');
  if (task.operation === 'modify_existing' && task.file_scope.length === 1 && !await existingSafeFile(projectRoot, task.file_scope[0]!)) {
    reasons.push('The scoped file is not an existing safe regular file in the target repository.');
  }
  if (task.operation === 'create' && (task.risk !== 'low' || task.complexity === 'complex')) reasons.push('New-file creation requires a low-risk, bounded task.');
  if (task.operation === 'create' && task.file_scope.length === 1 && projectRoot) {
    await resolveSafeCreationPath(projectRoot, task.file_scope[0]!).catch(error => {
      reasons.push(`Creation target is not authorized: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (task.complexity === 'moderate' && (task.acceptance_criteria.length < 2 || task.validation_requirements.length < 1)) {
    reasons.push('Moderate local work requires at least two acceptance criteria and explicit validation.');
  }
  if (task.risk === 'medium' && task.complexity !== 'simple' && task.acceptance_criteria.length < 2) {
    reasons.push('Medium-risk moderate work is not sufficiently bounded for local execution.');
  }
  const localEligible = reasons.length === 0;
  if (localEligible) reasons.push('Task fits the bounded single-file local-worker policy.');
  return {
    task_id: task.task_id,
    local_eligible: localEligible,
    enforced_executor: localEligible ? task.recommended_executor : 'cloud',
    reasons,
  };
}

export async function validateAndEnforcePlan(
  input: unknown,
  options: { projectRoot?: string; maxTasks?: number; inventory?: RepositoryInventory } = {},
): Promise<ImplementationPlan> {
  const parsed = implementationPlanSchema.safeParse(input);
  if (!parsed.success) throw new PlanValidationError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'plan'}: ${issue.message}`));
  const plan = parsed.data;
  let orderedTasks: PlanTask[];
  try {
    orderedTasks = orderTasksByDependencies(plan.tasks);
  } catch (error) {
    if (error instanceof DependencyGraphError) throw new PlanValidationError(error.reasons);
    throw error;
  }
  const errors: string[] = [];
  if (plan.tasks.length > (options.maxTasks ?? 8)) errors.push(`Plan exceeds the maximum of ${options.maxTasks ?? 8} tasks.`);
  const selectablePaths = options.inventory ? new Set(options.inventory.files.map(file => file.path)) : undefined;
  for (const task of plan.tasks) {
    if (task.file_scope.some(path => !safeScope(path))) {
      errors.push(`Task ${task.task_id} selected a protected or unsafe path.`);
    }
    if (selectablePaths && task.operation !== 'create') {
      for (const path of task.file_scope) {
        if (!selectablePaths.has(path)) {
          errors.push(`Task ${task.task_id} selected existing file ${path}, which is absent from the verified repository inventory; context is insufficient.`);
        }
      }
    }
  }
  if (errors.length > 0) throw new PlanValidationError(errors);

  const projectRoot = options.projectRoot ? await realpath(options.projectRoot) : undefined;
  const findings = await Promise.all(orderedTasks.map(task => routeTask(task, projectRoot)));
  const findingByTask = new Map(findings.map(finding => [finding.task_id, finding]));
  const tasks = orderedTasks.map(task => {
    const finding = findingByTask.get(task.task_id)!;
    if (task.recommended_executor === finding.enforced_executor) return task;
    return {
      ...task,
      recommended_executor: finding.enforced_executor,
      routing_explanation: `${task.routing_explanation} Deterministic policy override: ${finding.reasons.join(' ')}`,
    };
  });
  return implementationPlanSchema.parse({
    ...plan,
    tasks,
    routing_policy: { evaluated: true, findings },
  });
}
