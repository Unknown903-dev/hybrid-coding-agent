import { z } from 'zod';
import { createHash } from 'node:crypto';

const nonEmptyString = z.string().trim().min(1);

export const modelProposalFieldsSchema = z.object({
  summary: nonEmptyString,
  proposed_content: z.string(),
  checks: z.array(nonEmptyString),
  risks: z.array(nonEmptyString),
}).strict();

export const proposalSchema = z.object({
  operation: z.enum(['modify', 'create']).default('modify'),
  task: nonEmptyString,
  file: nonEmptyString,
  model: nonEmptyString,
  ...modelProposalFieldsSchema.shape,
  original_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expected_absent: z.literal(true).optional(),
  resulting_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((proposal, context) => {
  if (proposal.operation === 'create') {
    if (proposal.original_sha256 !== undefined) context.addIssue({ code: 'custom', path: ['original_sha256'], message: 'Create proposals cannot have an original source hash.' });
    if (proposal.expected_absent !== true) context.addIssue({ code: 'custom', path: ['expected_absent'], message: 'Create proposals require expected_absent=true.' });
    const digest = createHash('sha256').update(proposal.proposed_content).digest('hex');
    if (proposal.resulting_sha256 !== digest) context.addIssue({ code: 'custom', path: ['resulting_sha256'], message: 'Create proposal resulting hash does not match proposed content.' });
  } else if (proposal.expected_absent !== undefined || proposal.resulting_sha256 !== undefined) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'Modify proposals cannot use create-only preconditions.' });
  }
});

export type Proposal = z.infer<typeof proposalSchema>;

export function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const location = issue.path.length > 0 ? issue.path.join('.') : 'proposal';
    return `${location}: ${issue.message}`;
  });
}
