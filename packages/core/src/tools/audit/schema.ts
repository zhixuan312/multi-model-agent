// packages/core/src/tool-schemas/audit.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../shared-output.js';

// Ported verbatim from packages/mcp/src/tools/audit-document.ts (auditDocumentSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined here to avoid
// cross-package coupling.
export const inputSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  auditType: z.enum(['default', 'security', 'performance'])
    .default('default')
    .describe('Audit focus. `default` is the comprehensive sweep — recommended for specs, plans, designs, recommendation docs, post-mortems. Use `security` or `performance` only when you specifically want to narrow the lens to that single dimension (threat models, scaling designs).'),
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
});

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
