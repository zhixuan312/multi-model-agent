// packages/core/src/executors/delegate.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/delegate.js';
import type { TaskSpec, RunResult } from '../types.js';
import { runTasks } from '../run-tasks/index.js';
import type { RunTasksOptions } from '../run-tasks/index.js';
import { compileDelegateTasks } from '../intake/compilers/delegate.js';
import type { DelegateTaskInput } from '../intake/compilers/delegate.js';
import { runIntakePipeline } from '../intake/pipeline.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import type { ClarificationEntry } from '../intake/types.js';
import { notApplicable } from '../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../reporting/compose-terminal-headline.js';

export interface DelegateOptions {
  /**
   * Injects harness-level defaults (tools, timeoutMs, cwd, etc.) into each TaskSpec.
   * Provided by the MCP layer; a future REST layer will supply its own implementation.
   */
  injectDefaults: (tasks: TaskSpec[]) => TaskSpec[];
  /**
   * Optional override for `runTasks` — used in tests to inject a mock implementation.
   */
  runTasksOverride?: typeof runTasks;
  /**
   * Optional progress callback passed through to runTasks.
   */
  onProgress?: RunTasksOptions['onProgress'];
}

export interface DelegateOutput extends ExecutorOutput {
  clarifications?: ClarificationEntry[];
  tasks: TaskSpec[];
  wallClockMs: number;
}

export async function executeDelegate(
  ctx: ExecutionContext,
  input: Input,
  options: DelegateOptions,
): Promise<DelegateOutput> {
  const { config, projectContext, contextBlockStore } = ctx;
  const { injectDefaults, onProgress } = options;
  const runTasksImpl = options.runTasksOverride ?? runTasks;
  const { batchCache, clarifications: clarificationStore } = projectContext;

  // Intake pipeline: compile → infer → classify → resolve
  const requestId = randomUUID();
  const drafts = compileDelegateTasks(
    input.tasks as DelegateTaskInput[],
    requestId,
  );
  const intakeResult = runIntakePipeline(drafts, config, contextBlockStore);

  if (ctx.batchId === undefined) {
    throw new Error('executeDelegate requires ctx.batchId');
  }
  let results: RunResult[] = [];
  const readySpecs = intakeResult.ready.map(r => r.task);
  const batchId = batchCache.remember(ctx.batchId, readySpecs.length > 0 ? readySpecs : (input.tasks as TaskSpec[]));

  const batchStartMs = Date.now();
  let batchAborted = false;
  try {
    if (readySpecs.length > 0) {
      const resolvedTasks = injectDefaults(readySpecs);
      results = await runTasksImpl(resolvedTasks, config, {
        onProgress,
        runtime: { contextBlockStore },
        ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
        ...(ctx.recordHeartbeat !== undefined && { recordHeartbeat: ctx.recordHeartbeat }),
        logger: ctx.logger,
        ...(ctx.recorder !== undefined && { recorder: ctx.recorder }),
        ...(ctx.route !== undefined && { route: ctx.route }),
        ...(ctx.client !== undefined && { client: ctx.client }),
        ...(ctx.triggeringSkill !== undefined && { triggeringSkill: ctx.triggeringSkill }),
      });
      intakeResult.intakeProgress.executedDrafts = results.length;
    }
  } catch (err) {
    batchAborted = true;
    const message = err instanceof Error ? err.message : String(err);
    const fallback: RunResult = {
      output: '',
      status: 'error' as RunResult['status'],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      error: message,
      errorCode: 'executor_error',
      retryable: false,
      durationMs: 0,
      structuredError: { code: 'executor_error' as const, message, where: 'executor:delegate' },
      workerStatus: 'failed' as const,
    };
    results = readySpecs.length > 0 ? readySpecs.map(() => ({ ...fallback })) : [fallback];
  } finally {
    if (batchAborted) {
      try { batchCache.abort(batchId); } catch { /* already terminal */ }
    } else {
      try { batchCache.complete(batchId, results); } catch { /* already terminal */ }
    }
  }
  const wallClockMs = Date.now() - batchStartMs;

  // Create clarification set if needed
  let clarificationId: string | undefined;
  if (intakeResult.clarifications.length > 0) {
    const storedDrafts = intakeResult.clarifications.map(c => ({
      draft: drafts.find(d => d.draftId === c.draftId)!,
      taskIndex: c.taskIndex,
      roundCount: 0,
    }));
    clarificationId = clarificationStore.create(storedDrafts, batchId);
  }

  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);
  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  const awaitingClarification = intakeResult.clarifications.length > 0;
  const tasksTotal = readySpecs.length;
  const tasksCompleted = results.length;
  return {
    headline: composeTerminalHeadline({ tool: 'delegate', awaitingClarification, tasksTotal, tasksCompleted }),
    results: awaitingClarification ? notApplicable('awaiting clarification') : results,
    batchTimings: awaitingClarification ? notApplicable('awaiting clarification') : batchTimings,
    costSummary: awaitingClarification ? notApplicable('awaiting clarification') : costSummary,
    structuredReport: awaitingClarification
      ? notApplicable('awaiting clarification')
      : notApplicable('no structured report emitted by this executor'),
    error: notApplicable(awaitingClarification ? 'awaiting clarification' : 'batch succeeded'),
    proposedInterpretation: awaitingClarification
      ? notApplicable('clarification proposed but interpretation unavailable')
      : notApplicable('batch not awaiting clarification'),
    batchId,
    tasks: readySpecs,
    wallClockMs,
    parentModel,
    ...(clarificationId !== undefined && { clarificationId }),
    ...(intakeResult.clarifications.length > 0 && { clarifications: intakeResult.clarifications }),
  };
}
