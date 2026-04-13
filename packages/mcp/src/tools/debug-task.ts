import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  buildMetadataBlock,
  buildFilePathsPrompt,
  applyCommonFields,
} from './shared.js';

export const debugTaskSchema = z.object({
  problem: z.string().describe('Description of the problem to debug'),
  context: z.string().optional().describe('Additional context about the problem'),
  hypothesis: z.string().optional().describe('Initial hypothesis about the cause'),
  agentType: z.enum(['standard', 'complex']).optional(),
  ...commonToolFields,
});

export type DebugTaskParams = z.infer<typeof debugTaskSchema>;

export function registerDebugTask(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'debug_task',
    'Debug a problem using hypothesis-driven investigation. Always single-task \u2014 file paths provide context for the investigation. Preset: complex agent, 1 review round. Use delegate_tasks only for custom pipeline config.',
    debugTaskSchema.shape,
    async (params: DebugTaskParams) => {
      const agentType = params.agentType ?? 'complex';
      const parts: string[] = [`Debug this problem:\n\n${params.problem}`];
      if (params.context) parts.push(`Context: ${params.context}`);
      if (params.hypothesis) parts.push(`Initial hypothesis: ${params.hypothesis}`);
      const fileSection = buildFilePathsPrompt(params.filePaths);
      if (fileSection) parts.push(fileSection);
      parts.push('Use hypothesis-driven debugging: identify root cause, propose fix, verify.');
      const prompt = parts.join('\n\n');

      const taskSpec: Partial<TaskSpec> = applyCommonFields(
        { agentType, reviewPolicy: 'full' as const, maxReviewRounds: 1 },
        params,
      );

      try {
        const results = await runTasks([{ ...taskSpec, prompt } as TaskSpec], config);
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
