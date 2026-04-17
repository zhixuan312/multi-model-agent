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
  buildRunTasksOptions,
} from './shared.js';
import { buildFanOutResponse } from './batch-response.js';

export const reviewCodeSchema = z.object({
  code: z.string().optional().describe('Inline code to review'),
  focus: z.array(z.enum(['security', 'performance', 'correctness', 'style'])).optional(),
  ...commonToolFields,
});

export type ReviewCodeParams = z.infer<typeof reviewCodeSchema>;

const REVIEW_DONE_CONDITIONS: Record<string, string> = {
  security: 'Identify security vulnerabilities with severity, location, and remediation.',
  performance: 'Identify performance issues with impact level, location, and fix recommendation.',
  correctness: 'Identify logic errors, edge cases, and contract violations with severity and location.',
  style: 'Identify style issues, naming inconsistencies, and dead code with location and fix.',
};

function resolveReviewDoneCondition(focus: string[] | undefined): string {
  if (!focus || focus.length === 0) {
    return 'Review code for correctness, security, performance, and style. Each finding has category, severity, location, and recommendation.';
  }
  return focus.map(f => REVIEW_DONE_CONDITIONS[f] ?? '').filter(Boolean).join(' ');
}

function buildReviewPrompt(
  code: string | undefined,
  filePaths: string[] | undefined,
  focus: string[] | undefined,
): string {
  const parts: string[] = ['Review this code:'];
  if (code) parts.push(`\`\`\`\n${code}\n\`\`\``);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  if (focus && focus.length > 0) parts.push(`Focus areas: ${focus.join(', ')}.`);
  parts.push('Provide a structured review with findings and recommendations.');
  return parts.join('\n\n');
}

export function registerReviewCode(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'review_code',
    'Review code with full quality pipeline. Accepts inline code or file paths (multiple files review in parallel). Preset: complex agent, full review. Use delegate_tasks only for custom config.',
    reviewCodeSchema.shape,
    async (params: ReviewCodeParams, extra) => {
      const runOptions = buildRunTasksOptions(extra);
      const validation = validateInput(params.code, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const baseTaskSpec: Partial<TaskSpec> = {
        agentType: 'complex',
        reviewPolicy: 'full',
        briefQualityPolicy: 'off',
        done: resolveReviewDoneCondition(params.focus),
        tools: config.defaults?.tools ?? 'full',
        timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
        maxCostUSD: config.defaults?.maxCostUSD ?? 10,
        sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
        cwd: process.cwd(),
      };

      try {
        const mode = resolveDispatchMode(params.code, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const promptTemplate = buildReviewPrompt(undefined, undefined, params.focus);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config);
          return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs)] };
        }

        const prompt = buildReviewPrompt(params.code, params.filePaths, params.focus);
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
