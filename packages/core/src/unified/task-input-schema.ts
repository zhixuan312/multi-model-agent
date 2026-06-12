import { z } from 'zod';

const agentTierSchema = z.enum(['standard', 'complex']);
const reviewPolicySchema = z.enum(['reviewed', 'none']);
const sessionIdsSchema = z.object({
  implementer: z.string().optional(),
  reviewer: z.string().optional(),
}).optional();

const common = {
  agentTier: agentTierSchema.optional(),
  reviewPolicy: reviewPolicySchema.optional(),
  sessionIds: sessionIdsSchema,
  contextBlockIds: z.array(z.string()).optional(),
};

const delegateTaskSchema = z.object({
  prompt: z.string().min(1),
  agentType: agentTierSchema.optional(),
  filePaths: z.array(z.string()).optional(),
  done: z.string().optional(),
  contextBlockIds: z.array(z.string()).optional(),
});

export const taskInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delegate'), tasks: z.array(delegateTaskSchema).min(1), ...common }),
  z.object({ type: z.literal('audit'), document: z.string().optional(), filePaths: z.array(z.string()).optional(), subtype: z.enum(['default', 'plan', 'spec', 'skill']).optional(), ...common })
    .refine(d => d.document || (d.filePaths && d.filePaths.length > 0), { message: 'Either document or filePaths required' }),
  z.object({ type: z.literal('investigate'), question: z.string().min(1), filePaths: z.array(z.string()).optional(), ...common }),
  z.object({ type: z.literal('execute_plan'), filePaths: z.array(z.string()).min(1), taskDescriptors: z.array(z.string()).min(1), perTaskReviewPolicy: z.record(z.string(), z.string()).optional(), ...common }),
  z.object({ type: z.literal('review'), filePaths: z.array(z.string()).optional(), code: z.string().optional(), focus: z.array(z.string()).optional(), ...common }),
  z.object({ type: z.literal('debug'), errorMessage: z.string().min(1), filePaths: z.array(z.string()).optional(), ...common }),
  z.object({ type: z.literal('research'), researchQuestion: z.string().min(20), background: z.string().min(20), ...common }),
  z.object({ type: z.literal('journal_recall'), query: z.string().min(10), ...common }),
  z.object({ type: z.literal('journal_record'), entry: z.string().min(1), ...common }),
  z.object({ type: z.literal('retry_tasks'), batchId: z.string().uuid(), taskIndices: z.array(z.number().int().nonnegative()).min(1), ...common }),
]);

export type TaskInput = z.infer<typeof taskInputSchema>;
