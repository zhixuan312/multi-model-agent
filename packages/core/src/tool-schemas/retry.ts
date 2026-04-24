// packages/core/src/tool-schemas/retry.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from './shared-output.js';

// Ported verbatim from the inline retry_tasks registration in packages/mcp/src/cli.ts.
export const inputSchema = z.object({
  batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
  taskIndices: z
    .array(z.number().int().nonnegative())
    .describe('Zero-based indices (into the original batch) of the tasks to re-run'),
});

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
