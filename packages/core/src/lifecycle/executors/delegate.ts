// packages/core/src/executors/delegate.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { ExecutorOutput } from '../executor-output-types.js';
import type { Input } from '../../tools/delegate/schema.js';
import type { TaskSpec, RunResult } from '../../types.js';
import { runTasks } from '../dispatch-task.js';
import type { RunTasksOptions } from '../dispatch-task.js';
import { compileDelegateTasks } from '../../intake/brief-compiler-slots/delegate.js';
import type { DelegateTaskInput } from '../../intake/brief-compiler-slots/delegate.js';
import { runIntakePipeline } from '../../intake/pipeline.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../../reporting/not-applicable.js';
import { composeTerminalHeadline } from '../../reporting/compose-terminal-headline.js';

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
  tasks: TaskSpec[];
  wallClockMs: number;
}

export async function executeDelegate(
  ctx: ExecutionContext,
  input: Input,
  options: DelegateOptions,
): Promise<DelegateOutput> {
  const { config, contextBlockStore } = ctx;
  const { injectDefaults, onProgress } = options;
  const runTasksImpl = options.runTasksOverride ?? runTasks;
  const { batchCache } = ctx.projectContext!;

  // Intake pipeline: compile → infer → classify → resolve
  const requestId = randomUUID();
  const drafts = compileDelegateTasks(
    input.tasks as DelegateTaskInput[],
    requestId,
  );
  const intakeResult = runIntakePipeline(drafts, config, contextBlockStore, ctx.batchId);

  if (ctx.batchId === undefined) {
    throw new Error('executeDelegate requires ctx.batchId');
  }
  let results: RunResult[] = [];
  const readySpecs = intakeResult.ready.map(r => r.task);
  // Inject harness-level defaults (cwd, timeoutMs, maxCostUSD, etc.) so the
  // response envelope's `tasks` field reflects what was actually executed —
  // not the pre-inject intake output. Otherwise goldens that pin cwd/timeout
  // mismatch the response.
  const resolvedReadySpecs = readySpecs.length > 0 ? injectDefaults(readySpecs) : readySpecs;
  const batchId = batchCache.remember(ctx.batchId, resolvedReadySpecs.length > 0 ? resolvedReadySpecs : (input.tasks as TaskSpec[]));

  const batchStartMs = Date.now();
  let batchAborted = false;
  try {
    if (resolvedReadySpecs.length > 0) {
      results = await runTasksImpl(resolvedReadySpecs, config, {
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
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      parsedFindings: null,
      error: message,
      errorCode: 'runner_crash',
      retryable: false,
      durationMs: 0,
      structuredError: { code: 'runner_crash' as const, message, where: 'executor:delegate' },
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

  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);
  const mainModel = ctx.mainModel ?? config.defaults?.mainModel ?? undefined;

  const tasksTotal = readySpecs.length;
  const tasksCompleted = results.length;

  return {
    headline: composeTerminalHeadline({ tool: 'delegate', tasksTotal, tasksCompleted }),
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    batchId,
    tasks: resolvedReadySpecs,
    wallClockMs,
    mainModel,
  };
}
