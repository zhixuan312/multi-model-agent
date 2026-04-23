import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, ContextBlockStore, DiagnosticLogger, ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { executeExecutePlan } from '@zhixuan92/multi-model-agent-core/executors/index';
import {
  commonToolFields,
  buildUnifiedResponse,
  resolveParentModel,
  withDiagnostics,
} from './shared.js';
import { buildExecutionContextForMcp, buildMinimalExecutionContext } from '../execution-context.js';

export const executePlanSchema = z.object({
  tasks: z.array(
    z.string().trim().min(1, 'Task descriptor must be non-empty'),
  ).min(1, 'At least one task required')
    .refine(
      (tasks) => new Set(tasks).size === tasks.length,
      { message: 'Duplicate task descriptors are not allowed' },
    )
    .describe('Descriptive task strings matching plan headings, e.g. "1. Setup database schema". Multiple = parallel.'),
  context: z.string().optional()
    .describe('Short additional context the plan does not contain, e.g. "Tasks 1-16 are done, files already exist". Injected into the worker prompt.'),
  ...commonToolFields,
});

export type ExecutePlanParams = z.infer<typeof executePlanSchema>;

export function registerExecutePlan(
  server: McpServer,
  config: MultiModelConfig,
  logger: DiagnosticLogger,
  contextBlockStore?: ContextBlockStore,
  projectContext?: ProjectContext,
) {
  server.tool(
    'execute_plan',
    'Execute tasks from a written plan/spec file. Pass task descriptors and file paths — the worker reads the plan, finds the matching task, and implements it. Multiple tasks execute in parallel. Preset: standard agent, full review. Use this when a plan file exists on disk; use delegate_tasks instead when context is inline/ad-hoc with no plan file. Returns contextBlockId in metadata for follow-up calls.',
    executePlanSchema.shape,
    withDiagnostics('execute_plan', logger, (async (params: ExecutePlanParams) => {
      const ctx = projectContext
        ? buildExecutionContextForMcp(config, logger, projectContext, contextBlockStore ?? projectContext.contextBlocks)
        : buildMinimalExecutionContext(config, logger, contextBlockStore);
      const parentModel = resolveParentModel(config);

      const result = await executeExecutePlan(ctx, {
        tasks: params.tasks,
        context: params.context,
        filePaths: params.filePaths,
        contextBlockIds: params.contextBlockIds,
      });

      if ('isError' in result) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      return buildUnifiedResponse({
        batchId: result.batchId,
        results: result.results,
        tasks: result.results.map(() => ({ prompt: '', agentType: 'standard' as const })),
        wallClockMs: result.wallClockMs ?? 0,
        parentModel,
        contextBlockId: result.contextBlockId,
      });
    })),
  );
}
