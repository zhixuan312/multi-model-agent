// packages/core/src/tool-schemas/audit.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../shared-output.js';

// Ported verbatim from packages/mcp/src/tools/audit-document.ts (auditDocumentSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined here to avoid
// cross-package coupling.
export const inputSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  auditType: z.enum(['default', 'security', 'performance', 'plan'])
    .default('default')
    .describe('Audit focus. `default` is the comprehensive prose-coherence sweep — recommended for specs, designs, recommendation docs, post-mortems (the requirement / what-we-want-to-do prose). `security` / `performance` narrow the lens to that one dimension (threat models, scaling designs). `plan` is for code-execution PLANS being audited against a real codebase: pass the plan file as the single filePaths entry; workers grep the codebase under cwd to verify every named symbol / path / signature / import. Use `default` to check spec quality; use `plan` to check whether a plan can actually dispatch.'),
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel. For auditType=plan, MUST contain exactly one entry — the plan markdown.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
}).refine(
  (input) => input.auditType !== 'plan' || (Array.isArray(input.filePaths) && input.filePaths.length === 1),
  {
    message: "Plan audit takes exactly one filePath (the plan markdown). The worker discovers and verifies source files itself via its tool surface — do not pre-list source files.",
    path: ['filePaths'],
  },
);

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
