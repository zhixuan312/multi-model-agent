import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec, ContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import { runTasks, extractPlanSection } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  buildMetadataBlock,
  buildRunTasksOptions,
  resolveParentModel,
  autoRegisterContextBlock,
} from './shared.js';
import { buildFanOutResponse } from './batch-response.js';

export const executePlanSchema = z.object({
  tasks: z.array(
    z.string().trim().min(1, 'Task descriptor must be non-empty'),
  ).min(1, 'At least one task required')
    .refine(
      (tasks) => new Set(tasks).size === tasks.length,
      { message: 'Duplicate task descriptors are not allowed' },
    )
    .describe('Descriptive task strings matching plan headings, e.g. "1. Setup database schema". Multiple = parallel.'),
  context: z.string().optional()
    .describe('Short additional context the plan does not contain, e.g. "Tasks 1-16 are done, files already exist". Injected into the worker prompt.'),
  ...commonToolFields,
});

export type ExecutePlanParams = z.infer<typeof executePlanSchema>;

function buildExecutePlanPrompt(fileContents: string, task: string, context?: string): string {
  const parts = [
    'Below are the plan and/or spec documents for this project:',
    '',
    '---',
    fileContents,
    '---',
    '',
    'Execute the following task from the documents above:',
    '',
    `Requested task: "${task}"`,
  ];
  if (context) {
    parts.push('', `Additional context: ${context}`);
  }
  parts.push(
    '',
    'Find this task in the plan/spec documents above (not in any preceding context blocks),',
    'understand its requirements, and implement it fully.',
    'Follow any acceptance criteria, file paths, and constraints specified in the plan.',
    'If you cannot find a unique matching task, report that no match was found and do not implement anything.',
  );
  return parts.join('\n');
}

export function registerExecutePlan(server: McpServer, config: MultiModelConfig, contextBlockStore?: ContextBlockStore) {
  server.tool(
    'execute_plan',
    'Execute tasks from a written plan/spec file. Pass task descriptors and file paths — the worker reads the plan, finds the matching task, and implements it. Multiple tasks execute in parallel. Preset: standard agent, full review. Use this when a plan file exists on disk; use delegate_tasks instead when context is inline/ad-hoc with no plan file. Returns contextBlockId in metadata for follow-up calls.',
    executePlanSchema.shape,
    async (params: ExecutePlanParams, extra) => {
      const runOptions = buildRunTasksOptions(extra);
      const filePaths = params.filePaths;
      const validPaths = (filePaths ?? []).filter(p => p.trim().length > 0);

      if (validPaths.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Provide filePaths with at least one plan or spec file' }],
          isError: true,
        };
      }

      // Read all plan/spec files
      let fileContents: string;
      try {
        const contents = await Promise.all(
          validPaths.map(async (fp) => {
            const content = await readFile(fp, 'utf-8');
            return `--- ${fp} ---\n${content}`;
          }),
        );
        fileContents = contents.join('\n\n');
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error reading plan files: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const baseTaskSpec: Partial<TaskSpec> = {
        agentType: 'standard',
        reviewPolicy: 'full',
        briefQualityPolicy: 'off',
        done: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
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
        const tasks: TaskSpec[] = params.tasks.map(task => ({
          ...baseTaskSpec,
          prompt: buildExecutePlanPrompt(fileContents, task, params.context),
        } as TaskSpec));

        // Inject plan section context so spec reviewer checks implementation against the plan
        for (let i = 0; i < tasks.length; i++) {
          const section = await extractPlanSection(validPaths, params.tasks[i], baseTaskSpec.cwd);
          if (section) {
            tasks[i].planContext = section;
          }
        }

        if (tasks.length === 1) {
          const results = await runTasks(tasks, config, { ...runOptions, runtime });
          const result = results[0];
          if (!result) {
            return { content: [{ type: 'text' as const, text: 'Error: task produced no result' }], isError: true };
          }
          const ctxId = autoRegisterContextBlock(results, contextBlockStore);
          return { content: [{ type: 'text' as const, text: result.output }, buildMetadataBlock(result, parentModel, ctxId)] };
        }

        // Multiple tasks = fan out (parallel)
        const startMs = Date.now();
        const results = await runTasks(tasks, config, { ...runOptions, runtime });
        const ctxId = autoRegisterContextBlock(results, contextBlockStore);
        return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs, parentModel, ctxId)] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
