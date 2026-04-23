import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, ContextBlockStore, DiagnosticLogger, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { executeVerify } from '@zhixuan92/multi-model-agent-core/executors/index';
import {
  commonToolFields,
  validateInput,
  buildUnifiedResponse,
  resolveParentModel,
  withDiagnostics,
} from './shared.js';
import { buildExecutionContextForMcp, buildMinimalExecutionContext } from '../execution-context.js';

export const verifyWorkSchema = z.object({
  work: z.string().optional().describe('Inline work product to verify'),
  checklist: z.array(z.string()).min(1).describe('Verification checklist items (at least 1)'),
  ...commonToolFields,
});

export type VerifyWorkParams = z.infer<typeof verifyWorkSchema>;

export function registerVerifyWork(
  server: McpServer,
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  contextBlockStore?: ContextBlockStore,
  projectContext?: ProjectContext,
) {
  server.tool(
    'verify_work',
    'Verify work against a checklist with pass/fail evidence. Accepts inline description or file paths (multiple files verified in parallel). Preset: standard agent, spec review only.',
    verifyWorkSchema.shape,
    withDiagnostics('verify_work', logger, (async (params: VerifyWorkParams) => {
      const validation = validateInput(params.work, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const ctx = projectContext
        ? buildExecutionContextForMcp(config, logger, projectContext, contextBlockStore ?? projectContext.contextBlocks)
        : buildMinimalExecutionContext(config, logger, contextBlockStore);
      const parentModel = resolveParentModel(config);

      try {
        const result = await executeVerify(ctx, {
          work: params.work,
          checklist: params.checklist,
          filePaths: params.filePaths,
          contextBlockIds: params.contextBlockIds,
        });

        return buildUnifiedResponse({
          batchId: result.batchId,
          results: result.results,
          tasks: result.results.map(() => ({ prompt: '', agentType: 'standard' as const })),
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
