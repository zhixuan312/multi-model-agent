import { z } from 'zod';
import { SPEC_COMPONENTS } from './spec-components.js';

const agentTierSchema = z.enum(['standard', 'complex', 'main']);
const reviewPolicySchema = z.enum(['reviewed', 'none']);
const sessionIdsSchema = z.object({
  implementer: z.string().optional(),
  reviewer: z.string().optional(),
}).optional();

const targetSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).optional(),
  inline: z.string().min(1).optional(),
}).refine(
  (t) => {
    const hasPaths = t.paths !== undefined && t.paths.length > 0;
    const hasInline = t.inline !== undefined;
    return !(hasPaths && hasInline);
  },
  { message: 'target must have paths or inline, not both' },
);

const commonFields = {
  agentTier: agentTierSchema.optional(),
  reviewPolicy: reviewPolicySchema.optional(),
  sessionIds: sessionIdsSchema,
  contextBlockIds: z.array(z.string()).max(2).optional(),
};

export const taskInputSchema = z.discriminatedUnion('type', [
  // Read routes with target
  z.object({
    type: z.literal('audit'),
    subtype: z.enum(['default', 'plan', 'spec', 'skill']).optional(),
    prompt: z.string().optional(),
    target: targetSchema,
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('investigate'),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('review'),
    prompt: z.string().optional(),
    target: targetSchema,
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('debug'),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    ...commonFields,
  }).strict(),

  // Read routes without target
  z.object({
    type: z.literal('research'),
    prompt: z.string().min(20),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('journal_recall'),
    prompt: z.string().min(10),
    ...commonFields,
  }).strict(),

  // Write routes
  z.object({
    type: z.literal('delegate'),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    done: z.string().optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('execute_plan'),
    prompt: z.string().optional(),
    target: z.object({ paths: z.array(z.string().min(1)).length(1) }),
    tasks: z.array(z.string()).default([]),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('journal_record'),
    prompt: z.string().min(1),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('retry_tasks'),
    taskId: z.string().uuid(),
    taskIndices: z.array(z.number().int().nonnegative()).min(1),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('orchestrate'),
    prompt: z.string().min(1),
    outputFormat: z.string().optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('spec'),
    prompt: z.string().min(1),
    target: targetSchema,
    outputPath: z.string().optional(),
    components: z.array(z.enum(SPEC_COMPONENTS)).optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('plan'),
    prompt: z.string().min(1),
    target: targetSchema,
    outputPath: z.string().optional(),
    ...commonFields,
  }).strict(),
]);

export type TaskInput = z.infer<typeof taskInputSchema>;
