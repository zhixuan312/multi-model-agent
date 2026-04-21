import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec, ContextBlockStore, DiagnosticLogger } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  validateInput,
  resolveDispatchMode,
  buildUnifiedResponse,
  buildFilePathsPrompt,
  buildPerFilePrompt,
  buildRunTasksOptions,
  resolveParentModel,
  autoRegisterContextBlock,
  withDiagnostics,
} from './shared.js';

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

const DELTA_REVIEW_SUFFIX = ' Perform a full review (do not reduce thoroughness). Verify each prior finding as addressed or unaddressed. Omit addressed prior findings. Include unaddressed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveReviewDoneCondition(focus: string[] | undefined, hasContextBlocks: boolean): string {
  let base: string;
  if (!focus || focus.length === 0) {
    base = 'Review code for correctness, security, performance, and style. Each finding has category, severity, location, and recommendation.';
  } else {
    base = focus.map(f => REVIEW_DONE_CONDITIONS[f] ?? '').filter(Boolean).join(' ');
  }
  return hasContextBlocks ? base + DELTA_REVIEW_SUFFIX : base;
}

function buildReviewPrompt(
  code: string | undefined,
  filePaths: string[] | undefined,
  focus: string[] | undefined,
  hasContextBlocks: boolean,
): string {
  const parts: string[] = ['Review this code:'];
  if (code) parts.push(`\`\`\`\n${code}\n\`\`\``);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  if (focus && focus.length > 0) parts.push(`Focus areas: ${focus.join(', ')}.`);
  if (hasContextBlocks) {
    parts.push(
      'Context is provided above (e.g. a diff or prior review). Perform a full review as normal — do not skip areas or reduce thoroughness.',
      'If the context contains prior review findings:',
      '- **Omit** findings that have been addressed — do not re-report them.',
      '- **Include** findings that are still present (mark as "unfixed from prior review").',
      '- **Include** any new findings.',
      '- End with a **Fixed** summary listing which prior findings were resolved.',
    );
  } else {
    parts.push('Provide a structured review with findings and recommendations.');
  }
  return parts.join('\n\n');
}

export function registerReviewCode(server: McpServer, config: MultiModelConfig, logger: DiagnosticLogger, contextBlockStore?: ContextBlockStore) {
  server.tool(
    'review_code',
    'Review code with full quality pipeline. Accepts inline code or file paths (multiple files review in parallel). Preset: complex agent, full review. For diff-scoped reviews, register the git diff or prior review as a context block and pass its id in contextBlockIds — the tool automatically focuses on changes relative to that context.',
    reviewCodeSchema.shape,
    withDiagnostics('review_code', logger, (async (params: ReviewCodeParams, extra) => {
      const runOptions = buildRunTasksOptions(extra);
      const validation = validateInput(params.code, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const hasContextBlocks = Array.isArray(params.contextBlockIds) && params.contextBlockIds.length > 0;

      const baseTaskSpec: Partial<TaskSpec> = {
        agentType: 'complex',
        reviewPolicy: 'full',
        briefQualityPolicy: 'off',
        done: resolveReviewDoneCondition(params.focus, hasContextBlocks),
        tools: config.defaults?.tools ?? 'full',
        timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
        maxCostUSD: config.defaults?.maxCostUSD ?? 10,
        sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
        cwd: process.cwd(),
        contextBlockIds: params.contextBlockIds,
        parentModel: resolveParentModel(config),
      };
      const runtime = contextBlockStore ? { contextBlockStore } : undefined;
      const parentModel = baseTaskSpec.parentModel;

      try {
        const mode = resolveDispatchMode(params.code, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const promptTemplate = buildReviewPrompt(undefined, undefined, params.focus, hasContextBlocks);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config, { ...runOptions, runtime });
          const ctxId = autoRegisterContextBlock(results, contextBlockStore);
          return buildUnifiedResponse({
            batchId: randomUUID(),
            results,
            tasks,
            wallClockMs: Date.now() - startMs,
            parentModel,
            contextBlockId: ctxId,
          });
        }

        const prompt = buildReviewPrompt(params.code, params.filePaths, params.focus, hasContextBlocks);
        const results = await runTasks([{ ...baseTaskSpec, prompt } as TaskSpec], config, { ...runOptions, runtime });
        const ctxId = autoRegisterContextBlock(results, contextBlockStore);
        return buildUnifiedResponse({
          batchId: randomUUID(),
          results,
          tasks: [{ ...baseTaskSpec, prompt } as TaskSpec],
          wallClockMs: 0,
          parentModel,
          contextBlockId: ctxId,
        });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    })),
  );
}
