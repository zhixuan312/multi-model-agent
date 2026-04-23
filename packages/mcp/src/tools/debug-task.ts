import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, ContextBlockStore, DiagnosticLogger, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { executeDebug } from '@zhixuan92/multi-model-agent-core/executors/index';
import {
  commonToolFields,
  buildUnifiedResponse,
  resolveParentModel,
  withDiagnostics,
} from './shared.js';
import { buildExecutionContextForMcp, buildMinimalExecutionContext } from '../execution-context.js';

export const debugTaskSchema = z.object({
  problem: z.string().describe('What is broken'),
  context: z.string().optional().describe('Background'),
  hypothesis: z.string().optional().describe('Initial theory'),
  ...commonToolFields,
}).extend({
  filePaths: commonToolFields.filePaths.describe(
    'Files the sub-agent should focus on. For debug_task, all provided files are investigated together in a single task.',
  ),
});

export type DebugTaskParams = z.infer<typeof debugTaskSchema>;

export function registerDebugTask(
  server: McpServer,
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  contextBlockStore?: ContextBlockStore,
  projectContext?: ProjectContext,
) {
  server.tool(
    'debug_task',
    'Debug a problem with hypothesis-driven investigation. Always single-task. Preset: complex agent, 1 review round.',
    debugTaskSchema.shape,
    withDiagnostics('debug_task', logger, (async (params: DebugTaskParams) => {
      const ctx = projectContext
        ? buildExecutionContextForMcp(config, logger, projectContext, contextBlockStore ?? projectContext.contextBlocks)
        : buildMinimalExecutionContext(config, logger, contextBlockStore);
      const parentModel = resolveParentModel(config);

      try {
        const result = await executeDebug(ctx, {
          problem: params.problem,
          context: params.context,
          hypothesis: params.hypothesis,
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
