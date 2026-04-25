// packages/core/src/executors/execute-plan.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/execute-plan.js';
import type { TaskSpec } from '../types.js';
import { runTasks, extractPlanSection } from '../run-tasks/index.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';

/**
 * Build a compact worker prompt for one plan task.
 *
 * 3.1.7 shift: stop inlining the whole plan file (often 100+ KB). Instead
 * pass just the section for the current task — `extractPlanSection` already
 * pulls it cleanly. Fall back to naming the file path so the worker can
 * readFile it on demand when the heading can't be matched.
 */
function buildExecutePlanPrompt(
  filePaths: string[],
  task: string,
  taskSection: string | undefined,
  context?: string,
): string {
  const parts: string[] = [
    `Execute this task from the plan: "${task}"`,
    '',
  ];
  if (taskSection) {
    parts.push('Relevant plan section:', '', '---', taskSection.trim(), '---', '');
  } else {
    parts.push(
      `No unique plan section matched that task heading. The full plan file is at:`,
      ...filePaths.map((p) => `  - ${p}`),
      'Read the plan file(s) yourself to find the task.',
      '',
    );
  }
  parts.push(
    `Plan files for reference (read on demand if you need adjacent context):`,
    ...filePaths.map((p) => `  - ${p}`),
    '',
  );
  if (context) {
    parts.push(`Additional context: ${context}`, '');
  }
  parts.push(
    'Implement the task fully. Follow any acceptance criteria, file paths, and',
    'constraints in the plan section above. If you cannot find or understand',
    'the task, report that explicitly and do not implement anything.',
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

  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  const baseTaskSpec: Partial<TaskSpec> = {
    agentType: input.agentType ?? 'standard',
    reviewPolicy: input.reviewPolicy ?? 'full',
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

  // Build per-task specs. Extract the matching plan section ONCE per task
  // and use it for both the worker prompt and the spec reviewer context.
  // This keeps the worker prompt compact (~2-5 KB per task instead of
  // inlining the whole plan file, which was 100+ KB in practice).
  const tasks: TaskSpec[] = [];
  for (let i = 0; i < input.tasks.length; i++) {
    const taskDescriptor = input.tasks[i]!;
    const section = await extractPlanSection(validPaths, taskDescriptor, baseTaskSpec.cwd);
    const spec: TaskSpec = {
      ...baseTaskSpec,
      prompt: buildExecutePlanPrompt(validPaths, taskDescriptor, section, input.context),
    } as TaskSpec;
    if (section) {
      spec.planContext = section;
    }
    // Tell the worker which plan files exist so it can readFile them on demand.
    spec.filePaths = [...(baseTaskSpec.filePaths ?? []), ...validPaths];
    tasks.push(spec);
  }

  if (tasks.length === 1) {
    const results = await runTasks(tasks, config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }), logger: ctx.logger });
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
  const results = await runTasks(tasks, config, { runtime, ...(ctx.batchId !== undefined && { batchId: ctx.batchId }), ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }), logger: ctx.logger });
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
