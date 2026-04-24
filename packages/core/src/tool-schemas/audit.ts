// packages/core/src/tool-schemas/audit.ts
import { z } from 'zod';

// Ported verbatim from packages/mcp/src/tools/audit-document.ts (auditDocumentSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined here to avoid
// cross-package coupling.
export const inputSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  auditType: z.union([
    z.enum(['security', 'performance', 'correctness', 'style', 'general']),
    z.array(z.enum(['security', 'performance', 'correctness', 'style'])).min(1),
  ]).describe('Audit focus.'),
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
