// packages/core/src/tools/journal/recall/schema.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../../shared-output.js';

export const inputSchema = z.object({
  query: z.string().trim().min(10).max(4000)
    .describe('A conceptual question; the worker finds relevant prior learnings. No tags/keywords needed.'),
  contextBlockIds: z.array(z.string().trim().min(1)).optional(),
}).strict();

export type Input = z.infer<typeof inputSchema>;
export const outputSchema = buildOutputEnvelopeSchema();
export type Output = z.infer<typeof outputSchema>;
