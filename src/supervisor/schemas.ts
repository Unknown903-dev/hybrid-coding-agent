import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const relativeFile = nonEmpty.refine(value => {
  if (isAbsolute(value) || win32.isAbsolute(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}, 'File scope must contain safe repository-relative paths without traversal.');

export const riskSchema = z.enum(['low', 'medium', 'high']);
export const complexitySchema = z.enum(['simple', 'moderate', 'complex']);
export const executorSchema = z.enum(['local', 'cloud']);
export const operationSchema = z.enum(['modify_existing', 'create', 'delete']);

export const planTaskSchema = z.object({
  task_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: nonEmpty.max(200),
  description: nonEmpty.max(4_000),
  operation: operationSchema,
  file_scope: z.array(relativeFile).min(1).max(20),
  dependencies: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(50),
  acceptance_criteria: z.array(nonEmpty.max(1_000)).min(1).max(20),
  risk: riskSchema,
  complexity: complexitySchema,
  recommended_executor: executorSchema,
  routing_explanation: nonEmpty.max(2_000),
  validation_requirements: z.array(nonEmpty.max(1_000)).min(1).max(20),
  risk_tags: z.array(z.enum([
    'security', 'authentication', 'authorization', 'billing', 'migration',
    'deployment', 'infrastructure', 'data_loss', 'public_api', 'none',
  ])).min(1).max(10),
}).strict();

export const routingFindingSchema = z.object({
  task_id: nonEmpty,
  local_eligible: z.boolean(),
  enforced_executor: executorSchema,
  reasons: z.array(nonEmpty).min(1),
}).strict();

const planShapeSchema = z.object({
  schema_version: z.literal('1.0'),
  plan_id: z.string().uuid(),
  request: nonEmpty.max(10_000),
  summary: nonEmpty.max(4_000),
  context_status: z.enum(['sufficient', 'insufficient']).default('sufficient'),
  context_notes: z.string().trim().max(2_000).default('Verified repository context was sufficient for this plan.'),
  tasks: z.array(planTaskSchema).max(50),
  routing_policy: z.object({
    evaluated: z.literal(true),
    findings: z.array(routingFindingSchema),
  }).strict().optional(),
}).strict();

function validateContextStatus(
  plan: { context_status: 'sufficient' | 'insufficient'; tasks: unknown[] },
  context: z.RefinementCtx,
): void {
  if (plan.context_status === 'sufficient' && plan.tasks.length === 0) {
    context.addIssue({ code: 'custom', path: ['tasks'], message: 'A plan with sufficient context requires at least one task.' });
  }
  if (plan.context_status === 'insufficient' && plan.tasks.length > 0) {
    context.addIssue({ code: 'custom', path: ['tasks'], message: 'An insufficient-context plan must not invent implementation tasks.' });
  }
}

export const implementationPlanSchema = planShapeSchema.superRefine(validateContextStatus);
export const modelPlanSchema = planShapeSchema.omit({ routing_policy: true }).superRefine(validateContextStatus);

export type PlanTask = z.infer<typeof planTaskSchema>;
export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type RoutingFinding = z.infer<typeof routingFindingSchema>;

export const reviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  category: z.enum(['structure', 'automated_checks', 'semantic', 'security', 'scope', 'relevance']),
  summary: nonEmpty.max(2_000),
  evidence: nonEmpty.max(4_000),
}).strict();

export const supervisorReviewSchema = z.object({
  schema_version: z.literal('1.0'),
  verdict: z.enum(['ready_for_human_review', 'retry_local', 'cloud_escalation_recommended', 'rejected']),
  findings: z.array(reviewFindingSchema).max(50),
  remaining_risks: z.array(nonEmpty.max(2_000)).max(30),
  proposed_next_action: nonEmpty.max(2_000),
  semantic_correctness: z.enum(['not_established', 'plausible', 'concerns']),
  human_approval_required: z.literal(true),
}).strict();

export type SupervisorReview = z.infer<typeof supervisorReviewSchema>;

export function formatZodError(error: z.ZodError): string[] {
  return error.issues.map(issue => `${issue.path.join('.') || 'document'}: ${issue.message}`);
}

export const modelPlanJsonSchema = z.toJSONSchema(modelPlanSchema);
export const supervisorReviewJsonSchema = z.toJSONSchema(supervisorReviewSchema);
