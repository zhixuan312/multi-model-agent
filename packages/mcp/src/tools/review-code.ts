import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

export const reviewCodeSchema = z.object({
  code: z.string().describe('The code to review'),
  focus: z.array(z.enum(['security', 'performance', 'correctness', 'style'])).optional(),
  agentType: z.enum(['standard', 'complex']).optional(),
});

export type ReviewCodeParams = z.infer<typeof reviewCodeSchema>;

export function registerReviewCode(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'review_code',
    'Review code using a cross-model approach (standard agent implements, complex agent reviews).',
    reviewCodeSchema.shape,
    async (params: ReviewCodeParams) => {
      const agentType = params.agentType ?? 'complex';
      const focusText = params.focus ? `Focus areas: ${params.focus.join(', ')}.` : '';
      const prompt = `Review this code:\n\n\`\`\`\n${params.code}\n\`\`\`\n\n${focusText}\n\n` +
        `Provide a structured review with findings and recommendations.`;

      try {
        const results = await runTasks(
          [{ prompt, agentType, reviewPolicy: 'full' }],
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