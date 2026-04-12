import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

export const verifyWorkSchema = z.object({
  work: z.string().describe('The work product to verify'),
  checklist: z.array(z.string()).describe('Verification checklist items'),
  agentType: z.enum(['standard', 'complex']).optional(),
});

export type VerifyWorkParams = z.infer<typeof verifyWorkSchema>;

export function registerVerifyWork(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'verify_work',
    'Verify work product against a checklist using structured review.',
    verifyWorkSchema.shape,
    async (params: VerifyWorkParams) => {
      const agentType = params.agentType ?? 'standard';
      const checklistText = params.checklist.map((item, i) => `${i + 1}. ${item}`).join('\n');
      const prompt = `Verify this work:\n\n${params.work}\n\n` +
        `Checklist:\n${checklistText}\n\n` +
        `For each checklist item, indicate pass/fail and provide evidence.`;

      try {
        const results = await runTasks(
          [{ prompt, agentType, reviewPolicy: 'spec_only' }],
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