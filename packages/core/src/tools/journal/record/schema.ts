// packages/core/src/tools/journal/record/schema.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../../shared-output.js';

export const inputSchema = z.object({
  learning: z.string().min(20).max(8000)
    .describe('The raw learning to record — what was tried, what happened, the lesson.'),
  tagHints: z.array(z.string()).optional()
    .describe('Optional tag hints; the worker may revise/normalize them.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to the worker prompt.'),
}).strict();

export type Input = z.infer<typeof inputSchema>;
export const outputSchema = buildOutputEnvelopeSchema();
export type Output = z.infer<typeof outputSchema>;
