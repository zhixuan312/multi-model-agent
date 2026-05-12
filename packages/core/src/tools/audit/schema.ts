// packages/core/src/tool-schemas/audit.ts
import { z } from 'zod';
import { buildOutputEnvelopeSchema } from '../shared-output.js';

// Ported verbatim from packages/mcp/src/tools/audit-document.ts (auditDocumentSchema).
// commonToolFields (filePaths + contextBlockIds) are inlined here to avoid
// cross-package coupling.
export const inputSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  subtype: z.enum(['default', 'plan', 'spec', 'skill'])
    .default('default')
    .describe('Audit subtype — which artifact kind is being audited. `default` is the comprehensive prose-coherence sweep for design docs, recommendation docs, post-mortems, READMEs, briefs. `plan` is for code-execution plans audited against the actual codebase (pass the plan as the single filePaths entry; workers grep the codebase to verify every named symbol / path / signature / import). `spec` is for requirement-style prose (testability, scope explicitness, acceptance-criteria coverage). `skill` is for an mma-* skill markdown file (when_to_use specificity, input-shape completeness, anti-pattern coverage). For security or performance focus, include that emphasis in the free-text prompt — it is not a subtype.'),
  filePaths: z.array(z.string()).optional()
    .describe('Files the sub-agent should focus on. Multiple files are processed in parallel. For subtype=plan, MUST contain exactly one entry — the plan markdown.'),
  contextBlockIds: z.array(z.string()).optional()
    .describe('IDs from register_context_block to prepend to prompt. Use for delta audits, diff-scoped reviews, or shared specs.'),
}).strict().refine(
  (input) => input.subtype !== 'plan' || (Array.isArray(input.filePaths) && input.filePaths.length === 1),
  {
    message: "Plan audit takes exactly one filePath (the plan markdown). The worker discovers and verifies source files itself via its tool surface — do not pre-list source files.",
    path: ['filePaths'],
  },
);

export type Input = z.infer<typeof inputSchema>;

export const outputSchema = buildOutputEnvelopeSchema();

export type Output = z.infer<typeof outputSchema>;
