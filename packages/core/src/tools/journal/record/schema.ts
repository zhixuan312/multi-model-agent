import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../../shared-output.js';

export const inputSchema = z.object({
  learnings: z.array(z.string().min(20).max(8000)).min(1).max(20)
    .describe('One or more raw learnings to record in a single sequential integration pass.'),
  tagHints: z.array(z.string()).optional()
    .describe('Optional tag hints applied across ALL learnings; the worker may revise/normalize per node.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to the worker prompt.'),
}).strict();

export type Input = z.infer<typeof inputSchema>;
export const outputSchema = buildOutputEnvelopeSchema();
export type Output = z.infer<typeof outputSchema>;
