import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, ContextBlockStore, DiagnosticLogger, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { executeReview } from '@zhixuan92/multi-model-agent-core/executors/index';
import {
  commonToolFields,
  validateInput,
  buildUnifiedResponse,
  resolveParentModel,
  withDiagnostics,
} from './shared.js';
import { buildExecutionContextForMcp, buildMinimalExecutionContext } from '../execution-context.js';

export const reviewCodeSchema = z.object({
  code: z.string().optional().describe('Inline code to review'),
  focus: z.array(z.enum(['security', 'performance', 'correctness', 'style'])).optional(),
  ...commonToolFields,
});

export type ReviewCodeParams = z.infer<typeof reviewCodeSchema>;

export function registerReviewCode(
  server: McpServer,
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  contextBlockStore?: ContextBlockStore,
  projectContext?: ProjectContext,
) {
  server.tool(
    'review_code',
    'Review code with full quality pipeline. Accepts inline code or file paths (multiple files review in parallel). Preset: complex agent, full review. For diff-scoped reviews, register the git diff or prior review as a context block and pass its id in contextBlockIds — the tool automatically focuses on changes relative to that context.',
    reviewCodeSchema.shape,
    withDiagnostics('review_code', logger, (async (params: ReviewCodeParams) => {
      const validation = validateInput(params.code, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const ctx = projectContext
        ? buildExecutionContextForMcp(config, logger, projectContext, contextBlockStore ?? projectContext.contextBlocks)
        : buildMinimalExecutionContext(config, logger, contextBlockStore);
      const parentModel = resolveParentModel(config);

      try {
        const result = await executeReview(ctx, {
          code: params.code,
          focus: params.focus,
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
