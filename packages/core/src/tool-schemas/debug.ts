// packages/core/src/tool-schemas/debug.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from './shared-output.js';

// Ported verbatim from packages/mcp/src/tools/debug-task.ts (debugTaskSchema).
// The filePaths field has its description overridden in the original — reproduced here.
// commonToolFields (filePaths + contextBlockIds) are inlined to avoid cross-package coupling.
export const inputSchema = z.object({
  problem: z.string().describe('What is broken'),
  context: z.string().optional().describe('Background'),
  hypothesis: z.string().optional().describe('Initial theory'),
  filePaths: z.array(z.string()).optional().describe(
    'Files the sub-agent should focus on. For debug_task, all provided files are investigated together in a single task.',
  ),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
});

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
