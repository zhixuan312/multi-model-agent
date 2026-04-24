// packages/core/src/tool-schemas/verify.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from './shared-output.js';

// Ported verbatim from packages/mcp/src/tools/verify-work.ts (verifyWorkSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined here to avoid
// cross-package coupling.
export const inputSchema = z.object({
  work: z.string().optional().describe('Inline work product to verify'),
  checklist: z.array(z.string()).min(1).describe('Verification checklist items (at least 1)'),
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
});

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
