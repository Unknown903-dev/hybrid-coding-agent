import { z } from 'zod';
import { planTaskSchema, supervisorReviewSchema } from '../supervisor/schemas.js';

export const orchestrationStateSchema = z.enum([
  'created',
  'planning',
  'plan_validated',
  'local_generating',
  'proposal_validated',
  'executing',
  'repairing',
  'awaiting_cloud_review',
  'awaiting_human_review',
  'blocked',
  'failed',
]);

const transitionSchema = z.object({
  state: orchestrationStateSchema,
  timestamp: z.string().datetime(),
  detail: z.string().max(2_000).optional(),
}).strict();

const tokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  cache_write_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
}).strict();

export const orchestrationReportSchema = z.object({
  schema_version: z.literal('1.0'),
  run_id: z.string().uuid(),
  request: z.string().trim().min(1).max(10_000),
  project: z.string().trim().min(1).max(4_000),
  state: orchestrationStateSchema,
  transitions: z.array(transitionSchema).min(1).max(100),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  dry_run: z.boolean(),
  mode: z.enum(['single_task', 'multi_task']).optional(),
  local_model: z.string().trim().min(1).max(500),
  cloud_model: z.string().trim().min(1).max(500).optional(),
  plan_path: z.string().max(4_000).optional(),
  selected_task: planTaskSchema.optional(),
  selected_tasks: z.array(planTaskSchema).min(2).max(5).optional(),
  execution_order: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(2).max(5).optional(),
  task_results: z.array(z.object({
    task_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    file: z.string().trim().min(1).max(1_000),
    order: z.number().int().positive().max(5),
    dependencies: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(5).optional(),
    authorized_files: z.array(z.string().trim().min(1).max(1_000)).min(1).max(1).optional(),
    started_at: z.string().datetime().optional(),
    completed_at: z.string().datetime().optional(),
    source_sha256_before: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    source_sha256_after: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    status: z.enum(['pending', 'ready', 'running', 'passed', 'failed', 'blocked_by_dependency', 'blocked_by_policy']),
    proposal_validation: z.enum(['not_run', 'passed', 'failed']),
    automated_checks: z.enum(['not_run', 'passed', 'failed', 'skipped']),
    repair_attempts: z.number().int().nonnegative().max(5),
    proposal_path: z.string().max(4_000).optional(),
    execution_report_path: z.string().max(4_000).optional(),
    blocked_reason: z.string().max(4_000).optional(),
    error: z.string().max(4_000).optional(),
  }).strict()).max(5).optional(),
  combined_checks: z.object({
    status: z.enum(['not_run', 'passed', 'failed', 'skipped']),
    results: z.array(z.unknown()).max(20),
  }).strict().optional(),
  final_patch_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  human_approval_status: z.enum(['not_available', 'pending', 'approved', 'integrated']).optional(),
  worktree: z.object({
    location: z.string().max(4_000),
    preserved: z.boolean(),
    cleaned: z.boolean(),
  }).strict().optional(),
  proposal_path: z.string().max(4_000).optional(),
  execution_report_path: z.string().max(4_000).optional(),
  final_patch_path: z.string().max(4_000).optional(),
  cloud_review_path: z.string().max(4_000).optional(),
  cloud_usage_path: z.string().max(4_000).optional(),
  cloud_usage: z.object({
    call_budget: z.number().int().nonnegative(),
    calls_started: z.number().int().nonnegative(),
    calls_completed: z.number().int().nonnegative(),
    calls_failed: z.number().int().nonnegative(),
    token_usage: tokenUsageSchema.nullable(),
  }).strict(),
  validation: z.object({
    plan: z.enum(['not_run', 'passed', 'failed']),
    proposal: z.enum(['not_run', 'passed', 'failed']),
    automated_checks: z.enum(['not_run', 'passed', 'failed', 'skipped']),
  }).strict(),
  final_review: z.object({
    status: z.enum(['not_requested', 'awaiting', 'completed', 'unavailable']),
    verdict: supervisorReviewSchema.shape.verdict.optional(),
  }).strict(),
  failure_reason: z.string().max(4_000).optional(),
  human_approval_required: z.literal(true),
}).strict();

export type OrchestrationState = z.infer<typeof orchestrationStateSchema>;
export type OrchestrationReport = z.infer<typeof orchestrationReportSchema>;
