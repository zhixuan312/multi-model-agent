import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

export const executePlanTaskSchema = z.object({
  prompt: z.string().describe('Task prompt for the sub-agent'),
  agentType: z.enum(['standard', 'complex']).optional().describe('Which labor agent to use'),
  requiredCapabilities: z.array(z.enum(['web_search', 'web_fetch'])).optional(),
  maxTurns: z.number().optional(),
  timeoutMs: z.number().optional(),
  cwd: z.string().optional(),
  reviewPolicy: z.enum(['full', 'spec_only', 'off']).optional(),
  maxReviewRounds: z.number().optional(),
});

export type ExecutePlanTaskParams = z.infer<typeof executePlanTaskSchema>;

export function registerExecutePlanTask(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'execute_plan_task',
    'Execute a single task with optional TDD awareness. ' +
      'The task is run through the reviewed execution pipeline.',
    executePlanTaskSchema.shape,
    async (params: ExecutePlanTaskParams) => {
      try {
        const results = await runTasks(
          [{
            prompt: params.prompt,
            agentType: params.agentType ?? 'standard',
            requiredCapabilities: params.requiredCapabilities,
            maxTurns: params.maxTurns,
            timeoutMs: params.timeoutMs,
            cwd: params.cwd,
            reviewPolicy: params.reviewPolicy,
            maxReviewRounds: params.maxReviewRounds,
          }],
          config,
        );

        const result = results[0];
        return {
          content: [
            { type: 'text' as const, text: result.output },
            { type: 'text' as const, text: JSON.stringify({
              status: result.status,
              workerStatus: result.workerStatus,
              specReviewStatus: result.specReviewStatus,
              qualityReviewStatus: result.qualityReviewStatus,
              usage: result.usage,
            }, null, 2) },
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