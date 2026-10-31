import { z } from 'zod';
import { isAbsolute, win32 } from 'node:path';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const safeFileSchema = z.string().trim().min(1).max(1_000).refine(value =>
  !isAbsolute(value) && !win32.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) &&
  !value.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..'),
  'Expected a safe repository-relative path.',
);

export const approvalRecordSchema = z.object({
  schema_version: z.literal('1.0'),
  record_type: z.literal('human_patch_approval'),
  approval_id: z.string().uuid(),
  run_id: z.string().uuid(),
  approved_at: z.string().datetime(),
  authorization_method: z.enum(['explicit_flag', 'interactive_confirmation']),
  repository_root: z.string().trim().min(1).max(4_000),
  repository_id: sha256Schema,
  head_at_approval: gitObjectIdSchema,
  patch_path: z.string().trim().min(1).max(4_000),
  patch_sha256: sha256Schema,
  approved_files: z.array(safeFileSchema).min(1).max(5),
  source_sha256: z.record(safeFileSchema, sha256Schema),
  orchestration_report_sha256: sha256Schema,
  execution_report_sha256: sha256Schema,
  validation_artifact_sha256: sha256Schema.optional(),
  review_report_sha256: sha256Schema,
  human_approval_required_after_integration: z.literal(true),
  signature: sha256Schema,
}).strict();

export const integrationAuditSchema = z.object({
  schema_version: z.literal('1.0'),
  record_type: z.literal('patch_integration_audit'),
  integration_id: z.string().uuid(),
  run_id: z.string().uuid(),
  attempted_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  repository_root: z.string().trim().min(1).max(4_000),
  repository_id: sha256Schema,
  head_before_integration: gitObjectIdSchema,
  patch_sha256: sha256Schema,
  approval_path: z.string().trim().min(1).max(4_000),
  approved_files: z.array(safeFileSchema).min(1).max(5),
  status: z.enum(['succeeded', 'failed']),
  changed_files: z.array(safeFileSchema).max(20),
  original_source_sha256: z.record(safeFileSchema, sha256Schema).optional(),
  resulting_source_sha256: z.record(safeFileSchema, sha256Schema).optional(),
  rollback: z.object({
    attempted: z.boolean(),
    succeeded: z.boolean(),
    manual_recovery_required: z.boolean(),
    affected_paths: z.array(safeFileSchema).max(5),
  }).strict().optional(),
  error: z.string().max(4_000).optional(),
  commit_created: z.literal(false),
  push_performed: z.literal(false),
  merge_performed: z.literal(false),
  deployment_performed: z.literal(false),
  signature: sha256Schema,
}).strict();

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type IntegrationAudit = z.infer<typeof integrationAuditSchema>;
