import { z } from 'zod';
import { buildOutputEnvelopeSchema } from './shared-output.js';

export const inputSchema = z.object({
  question: z.string().trim().min(1, 'question required'),
  filePaths: z.array(z.string().trim().min(1)).optional(),
  contextBlockIds: z.array(z.string().trim().min(1)).optional(),
  agentType: z.enum(['standard', 'complex']).optional(),
  tools: z.enum(['none', 'readonly'], {
    error: () => ({ message: "investigate_codebase supports only tools 'none' or 'readonly'" }),
  }).optional(),
}).strict();

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();
export type Output = z.infer<typeof outputSchema>;
