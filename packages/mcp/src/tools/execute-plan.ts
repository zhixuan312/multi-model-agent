import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec, ContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  buildMetadataBlock,
  buildRunTasksOptions,
  resolveParentModel,
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
  ...commonToolFields,
});

export type ExecutePlanParams = z.infer<typeof executePlanSchema>;

function buildExecutePlanPrompt(fileContents: string, task: string): string {
  return [
    'Below are the plan and/or spec documents for this project:',
    '',
    '---',
    fileContents,
    '---',
    '',
    'Execute the following task from the documents above:',
    '',
    `Requested task: "${task}"`,
    '',
    'Find this task in the plan/spec documents above (not in any preceding context blocks),',
    'understand its requirements, and implement it fully.',
    'Follow any acceptance criteria, file paths, and constraints specified in the plan.',
    'If you cannot find a unique matching task, report that no match was found and do not implement anything.',
  ].join('\n');
}

export function registerExecutePlan(server: McpServer, config: MultiModelConfig, contextBlockStore?: ContextBlockStore) {
  server.tool(
    'execute_plan',
    'Execute tasks from a plan document. Pass task descriptors and plan/spec file paths \u2014 the worker reads the plan, finds the matching task, and implements it. Multiple tasks execute in parallel. Preset: standard agent, full review.',
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
          prompt: buildExecutePlanPrompt(fileContents, task),
        } as TaskSpec));

        if (tasks.length === 1) {
          const results = await runTasks(tasks, config, { ...runOptions, runtime });
          const result = results[0];
          if (!result) {
            return { content: [{ type: 'text' as const, text: 'Error: task produced no result' }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: result.output }, buildMetadataBlock(result, parentModel)] };
        }

        // Multiple tasks = fan out (parallel)
        const startMs = Date.now();
        const results = await runTasks(tasks, config, { ...runOptions, runtime });
        return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs, parentModel)] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
