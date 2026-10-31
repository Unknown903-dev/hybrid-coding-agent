import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const proposalSchema = z.object({
  task: nonEmptyString,
  file: nonEmptyString,
  model: nonEmptyString,
  summary: nonEmptyString,
  proposed_content: z.string(),
  checks: z.array(nonEmptyString),
  risks: z.array(nonEmptyString),
}).strict();

export type Proposal = z.infer<typeof proposalSchema>;

export function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const location = issue.path.length > 0 ? issue.path.join('.') : 'proposal';
    return `${location}: ${issue.message}`;
  });
}
