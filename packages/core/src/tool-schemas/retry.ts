// packages/core/src/tool-schemas/retry.ts
import { z } from 'zod';

// Ported verbatim from the inline retry_tasks registration in packages/mcp/src/cli.ts.
export const inputSchema = z.object({
  batchId: z.string().describe('Batch id returned from a previous delegate_tasks call'),
  taskIndices: z
    .array(z.number().int().nonnegative())
    .describe('Zero-based indices (into the original batch) of the tasks to re-run'),
});

export type Input = z.infer<typeof inputSchema>;

// Uniform output envelope — required for GET /batch/:id?taskIndex=N slicing (see spec §6.5)
export const outputSchema = z.object({
  results: z.array(z.unknown()),           // per-task RunResult, index-aligned with input tasks
  headline: z.string(),
  batchTimings: z.object({}).passthrough(),
  costSummary: z.object({}).passthrough(),
}).passthrough();

export type Output = z.infer<typeof outputSchema>;
