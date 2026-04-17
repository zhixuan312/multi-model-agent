import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec, ContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  buildMetadataBlock,
  buildFilePathsPrompt,
  buildRunTasksOptions,
} from './shared.js';

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

export function registerDebugTask(server: McpServer, config: MultiModelConfig, contextBlockStore?: ContextBlockStore) {
  server.tool(
    'debug_task',
    'Debug a problem with hypothesis-driven investigation. Always single-task. Preset: complex agent, 1 review round.',
    debugTaskSchema.shape,
    async (params: DebugTaskParams, extra) => {
      const runOptions = buildRunTasksOptions(extra);
      const parts: string[] = [`Debug this problem:\n\n${params.problem}`];
      if (params.context) parts.push(`Context: ${params.context}`);
      if (params.hypothesis) parts.push(`Initial hypothesis: ${params.hypothesis}`);
      const fileSection = buildFilePathsPrompt(params.filePaths);
      if (fileSection) parts.push(fileSection);
      parts.push('Use hypothesis-driven debugging: identify root cause, propose fix, verify.');
      const prompt = parts.join('\n\n');

      const taskSpec: Partial<TaskSpec> = {
        agentType: 'complex',
        reviewPolicy: 'full',
        briefQualityPolicy: 'off',
        done: 'Identify the root cause with evidence (file, line, mechanism). Propose a fix. Verify the fix resolves the problem.',
        maxReviewRounds: 1,
        tools: config.defaults?.tools ?? 'full',
        timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
        maxCostUSD: config.defaults?.maxCostUSD ?? 10,
        sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
        cwd: process.cwd(),
        contextBlockIds: params.contextBlockIds,
      };
      const runtime = contextBlockStore ? { contextBlockStore } : undefined;

      try {
        const results = await runTasks([{ ...taskSpec, prompt } as TaskSpec], config, { ...runOptions, runtime });
        const result = results[0];
        return { content: [{ type: 'text' as const, text: result.output }, buildMetadataBlock(result)] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
