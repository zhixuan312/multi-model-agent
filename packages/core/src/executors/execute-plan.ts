// packages/core/src/executors/execute-plan.ts
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/execute-plan.js';
import type { TaskSpec } from '../types.js';
import { runTasks, extractPlanSection } from '../run-tasks.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';

// --- Ported from packages/mcp/src/tools/execute-plan.ts ---

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

function autoRegisterContextBlock(
  results: import('../types.js').RunResult[],
  store: import('../context/context-block-store.js').ContextBlockStore | undefined,
): string | undefined {
  if (!store) return undefined;
  const usable = results.filter(r => !r.outputIsDiagnostic && r.output.trim().length > 0);
  if (usable.length === 0) return undefined;
  const combined = usable.map(r => r.output).join('\n\n---\n\n');
  const { id } = store.register(combined);
  return id;
}

export interface ExecutePlanValidationError {
  error: string;
  isError: true;
}

export interface ExecutePlanOutput extends ExecutorOutput {
  contextBlockId?: string;
}

export async function executeExecutePlan(
  ctx: ExecutionContext,
  input: Input,
): Promise<ExecutePlanOutput | ExecutePlanValidationError> {
  const { config, contextBlockStore } = ctx;

  const filePaths = input.filePaths;
  const validPaths = (filePaths ?? []).filter(p => p.trim().length > 0);

  if (validPaths.length === 0) {
    return {
      error: 'Provide filePaths with at least one plan or spec file',
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
      error: `Error reading plan files: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  const baseTaskSpec: Partial<TaskSpec> = {
    agentType: 'standard',
    reviewPolicy: 'full',
    briefQualityPolicy: 'off',
    done: 'Implement the task fully. Report: which task heading you matched, what files were created or modified, and any issues encountered. If no unique matching task was found, report that explicitly and do not implement anything.',
    tools: config.defaults?.tools ?? 'full',
    timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
    maxCostUSD: config.defaults?.maxCostUSD ?? 10,
    sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
    cwd: ctx.projectContext.cwd,
    contextBlockIds: input.contextBlockIds,
    parentModel,
    autoCommit: true,
  };
  const runtime = contextBlockStore ? { contextBlockStore } : undefined;

  const tasks: TaskSpec[] = input.tasks.map(task => ({
    ...baseTaskSpec,
    prompt: buildExecutePlanPrompt(fileContents, task, input.context),
  } as TaskSpec));

  // Inject plan section context so spec reviewer checks implementation against the plan
  for (let i = 0; i < tasks.length; i++) {
    const section = await extractPlanSection(validPaths, input.tasks[i], baseTaskSpec.cwd);
    if (section) {
      tasks[i].planContext = section;
    }
  }

  if (tasks.length === 1) {
    const results = await runTasks(tasks, config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }) });
    const result = results[0];
    if (!result) {
      return {
        error: 'task produced no result',
        isError: true,
      };
    }
    const ctxId = autoRegisterContextBlock(results, contextBlockStore);
    const batchTimings = computeTimings(0, results);
    const costSummary = computeAggregateCost(results);

    return {
      headline: composeTerminalHeadline({ tool: 'executePlan', awaitingClarification: false, tasksTotal: 1, tasksCompleted: results.length }),
      results,
      batchTimings,
      costSummary,
      structuredReport: notApplicable('no structured report emitted by this executor'),
      error: notApplicable('batch succeeded'),
      proposedInterpretation: notApplicable('batch not awaiting clarification'),
      batchId: randomUUID(),
      wallClockMs: 0,
      parentModel,
      ...(ctxId !== undefined && { contextBlockId: ctxId }),
    };
  }

  // Multiple tasks = fan out (parallel)
  const startMs = Date.now();
  const results = await runTasks(tasks, config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }) });
  const wallClockMs = Date.now() - startMs;
  const ctxId = autoRegisterContextBlock(results, contextBlockStore);
  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);

  return {
    headline: composeTerminalHeadline({ tool: 'executePlan', awaitingClarification: false, tasksTotal: tasks.length, tasksCompleted: results.length }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: randomUUID(),
    wallClockMs,
    parentModel,
    ...(ctxId !== undefined && { contextBlockId: ctxId }),
  };
}
