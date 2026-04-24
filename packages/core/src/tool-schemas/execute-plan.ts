// packages/core/src/tool-schemas/execute-plan.ts
import { z } from 'zod';

// Ported verbatim from packages/mcp/src/tools/execute-plan.ts (executePlanSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined to avoid cross-package coupling.
export const inputSchema = z.object({
  tasks: z.array(
    z.string().trim().min(1, 'Task descriptor must be non-empty'),
  ).min(1, 'At least one task required')
    .refine(
      (tasks) => new Set(tasks).size === tasks.length,
      { message: 'Duplicate task descriptors are not allowed' },
    )
    .describe('Descriptive task strings matching plan headings, e.g. "1. Setup database schema". Multiple = parallel.'),
  context: z.string().optional()
    .describe('Short additional context the plan does not contain, e.g. "Tasks 1-16 are done, files already exist". Injected into the worker prompt.'),
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
