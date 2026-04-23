import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, ContextBlockStore, DiagnosticLogger, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { executeAudit } from '@zhixuan92/multi-model-agent-core/executors/index';
import {
  commonToolFields,
  validateInput,
  buildUnifiedResponse,
  resolveParentModel,
  withDiagnostics,
} from './shared.js';
import { buildExecutionContextForMcp, buildMinimalExecutionContext } from '../execution-context.js';

export const auditDocumentSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  auditType: z.union([
    z.enum(['security', 'performance', 'correctness', 'style', 'general']),
    z.array(z.enum(['security', 'performance', 'correctness', 'style'])).min(1),
  ]).describe('Audit focus.'),
  ...commonToolFields,
});

export type AuditDocumentParams = z.infer<typeof auditDocumentSchema>;

export function registerAuditDocument(
  server: McpServer,
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  contextBlockStore?: ContextBlockStore,
  projectContext?: ProjectContext,
) {
  server.tool(
    'audit_document',
    'Audit documents for issues. Accepts inline content or file paths (multiple files audit in parallel). Preset: complex agent, no review. For delta audits (round 2+), register the prior audit report as a context block and pass its id in contextBlockIds — the tool automatically switches to delta mode, reporting only new findings, unfixed findings, and confirming fixes.',
    auditDocumentSchema.shape,
    withDiagnostics('audit_document', logger, (async (params: AuditDocumentParams) => {
      const validation = validateInput(params.document, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const ctx = projectContext
        ? buildExecutionContextForMcp(config, logger, projectContext, contextBlockStore ?? projectContext.contextBlocks)
        : buildMinimalExecutionContext(config, logger, contextBlockStore);
      const parentModel = resolveParentModel(config);

      try {
        const result = await executeAudit(ctx, {
          document: params.document,
          auditType: params.auditType,
          filePaths: params.filePaths,
          contextBlockIds: params.contextBlockIds,
        });

        return buildUnifiedResponse({
          batchId: result.batchId,
          results: result.results,
          tasks: result.results.map(() => ({ prompt: '', agentType: 'complex' as const })),
          wallClockMs: result.wallClockMs ?? 0,
          parentModel,
          contextBlockId: result.contextBlockId,
        });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    })),
  );
}
