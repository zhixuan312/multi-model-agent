import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  validateInput,
  resolveDispatchMode,
  buildMetadataBlock,
  buildFilePathsPrompt,
  buildPerFilePrompt,
  applyCommonFields,
} from './shared.js';
import { buildFanOutResponse } from './batch-response.js';

export const verifyWorkSchema = z.object({
  work: z.string().optional().describe('Inline work product to verify'),
  checklist: z.array(z.string()).min(1).describe('Verification checklist items (at least 1)'),
  agentType: z.enum(['standard', 'complex']).optional(),
  ...commonToolFields,
});

export type VerifyWorkParams = z.infer<typeof verifyWorkSchema>;

function buildVerifyPrompt(
  work: string | undefined,
  filePaths: string[] | undefined,
  checklist: string[],
): string {
  const parts: string[] = ['Verify this work:'];
  if (work) parts.push(work);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  const checklistText = checklist.map((item, i) => `${i + 1}. ${item}`).join('\n');
  parts.push(`Checklist:\n${checklistText}`);
  parts.push('For each checklist item, indicate pass/fail and provide evidence.');
  return parts.join('\n\n');
}

export function registerVerifyWork(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'verify_work',
    'Verify completed work against a checklist with pass/fail evidence. Accepts inline description or file paths \u2014 multiple files are verified in parallel, each against the same checklist. Preset: standard agent, spec review only. Use delegate_tasks only for custom pipeline config.',
    verifyWorkSchema.shape,
    async (params: VerifyWorkParams) => {
      const validation = validateInput(params.work, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const agentType = params.agentType ?? 'standard';
      const baseTaskSpec: Partial<TaskSpec> = applyCommonFields(
        { agentType, reviewPolicy: 'spec_only' as const },
        params,
      );

      try {
        const mode = resolveDispatchMode(params.work, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const promptTemplate = buildVerifyPrompt(undefined, undefined, params.checklist);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config);
          return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs)] };
        }

        const prompt = buildVerifyPrompt(params.work, params.filePaths, params.checklist);
        const results = await runTasks([{ ...baseTaskSpec, prompt } as TaskSpec], config);
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