import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

export const debugTaskSchema = z.object({
  problem: z.string().describe('Description of the problem to debug'),
  context: z.string().optional().describe('Additional context about the problem'),
  hypothesis: z.string().optional().describe('Initial hypothesis about the cause'),
  agentType: z.enum(['standard', 'complex']).optional(),
});

export type DebugTaskParams = z.infer<typeof debugTaskSchema>;

export function registerDebugTask(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'debug_task',
    'Debug a problem using hypothesis-driven approach with two attempts.',
    debugTaskSchema.shape,
    async (params: DebugTaskParams) => {
      const agentType = params.agentType ?? 'complex';
      const prompt = `Debug this problem:\n\n${params.problem}\n\n` +
        (params.context ? `Context: ${params.context}\n\n` : '') +
        (params.hypothesis ? `Initial hypothesis: ${params.hypothesis}\n\n` : '') +
        `Use hypothesis-driven debugging: identify root cause, propose fix, verify.`;

      try {
        const results = await runTasks(
          [{ prompt, agentType, maxReviewRounds: 1 }],
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