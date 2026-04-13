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

export const reviewCodeSchema = z.object({
  code: z.string().optional().describe('Inline code to review'),
  focus: z.array(z.enum(['security', 'performance', 'correctness', 'style'])).optional(),
  outputFormat: z.enum(['json', 'markdown']).optional(),
  agentType: z.enum(['standard', 'complex']).optional(),
  ...commonToolFields,
});

export type ReviewCodeParams = z.infer<typeof reviewCodeSchema>;

function buildReviewPrompt(
  code: string | undefined,
  filePaths: string[] | undefined,
  focus: string[] | undefined,
  outputFormat: string | undefined,
): string {
  const parts: string[] = ['Review this code:'];
  if (code) parts.push(`\`\`\`\n${code}\n\`\`\``);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  if (focus && focus.length > 0) parts.push(`Focus areas: ${focus.join(', ')}.`);
  if (outputFormat === 'json') {
    parts.push('Return findings as a JSON array of objects with keys: severity, category, file, line, finding, recommendation.');
  }
  parts.push('Provide a structured review with findings and recommendations.');
  return parts.join('\n\n');
}

export function registerReviewCode(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'review_code',
    'Review code with the full quality pipeline (spec review + quality review). Accepts inline code or file paths \u2014 multiple files are reviewed in parallel. Preset: complex agent, full review. Use this when code needs thorough review. Use delegate_tasks only for custom pipeline config.',
    reviewCodeSchema.shape,
    async (params: ReviewCodeParams) => {
      const validation = validateInput(params.code, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const agentType = params.agentType ?? 'complex';
      const baseTaskSpec: Partial<TaskSpec> = applyCommonFields(
        {
          agentType,
          reviewPolicy: 'full' as const,
          ...(params.outputFormat && { formatConstraints: { outputFormat: params.outputFormat } }),
        },
        params,
      );

      try {
        const mode = resolveDispatchMode(params.code, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const promptTemplate = buildReviewPrompt(undefined, undefined, params.focus, params.outputFormat);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config);
          return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs)] };
        }

        const prompt = buildReviewPrompt(params.code, params.filePaths, params.focus, params.outputFormat);
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
