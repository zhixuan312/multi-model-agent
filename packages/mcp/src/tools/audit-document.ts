import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

export const auditDocumentSchema = z.object({
  document: z.string().describe('The document to audit'),
  auditType: z.enum(['security', 'performance', 'correctness', 'style']).describe('Type of audit'),
  agentType: z.enum(['standard', 'complex']).optional(),
});

export type AuditDocumentParams = z.infer<typeof auditDocumentSchema>;

export function registerAuditDocument(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'audit_document',
    'Audit a document for security, performance, correctness, or style issues using a single agent (defaults to complex).',
    auditDocumentSchema.shape,
    async (params: AuditDocumentParams) => {
      const agentType = params.agentType ?? 'complex';
      const prompt = `Audit this document for ${params.auditType}:\n\n${params.document}\n\n` +
        `Provide a structured audit report with findings and severity.`;

      try {
        const results = await runTasks(
          [{ prompt, agentType, reviewPolicy: 'off' }],
          config,
        );

        const result = results[0];
        return {
          content: [
            { type: 'text' as const, text: result.output },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );
}