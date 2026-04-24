// packages/core/src/tool-schemas/review.ts
import { z } from 'zod';

// Ported verbatim from packages/mcp/src/tools/review-code.ts (reviewCodeSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined here to avoid
// cross-package coupling.
export const inputSchema = z.object({
  code: z.string().optional().describe('Inline code to review'),
  focus: z.array(z.enum(['security', 'performance', 'correctness', 'style'])).optional(),
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
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
