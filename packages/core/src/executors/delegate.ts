// packages/core/src/executors/delegate.ts
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/delegate.js';
import type { TaskSpec, RunResult } from '../types.js';
import { runTasks } from '../run-tasks.js';
import type { RunTasksOptions } from '../run-tasks.js';
import { compileDelegateTasks } from '../intake/compilers/delegate.js';
import { runIntakePipeline } from '../intake/pipeline.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import type { ClarificationEntry } from '../intake/types.js';

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
    input.tasks as { prompt: string; done?: string; filePaths?: string[]; agentType?: string; contextBlockIds?: string[] }[],
    requestId,
  );
  const intakeResult = runIntakePipeline(drafts, config, contextBlockStore);

  let results: RunResult[] = [];
  const readySpecs = intakeResult.ready.map(r => r.task);
  const batchId = batchCache.remember(readySpecs.length > 0 ? readySpecs : (input.tasks as TaskSpec[]));

  const batchStartMs = Date.now();
  let batchAborted = false;
  try {
    if (readySpecs.length > 0) {
      const resolvedTasks = injectDefaults(readySpecs);
      results = await runTasksImpl(resolvedTasks, config, {
        onProgress,
        runtime: { contextBlockStore },
      });
      intakeResult.intakeProgress.executedDrafts = results.length;
    }
  } catch (err) {
    batchAborted = true;
    throw err;
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

  return {
    results,
    headline: '',  // composed by the caller using composeHeadline
    batchTimings,
    costSummary,
    batchId,
    tasks: readySpecs,
    wallClockMs,
    parentModel,
    ...(clarificationId !== undefined && { clarificationId }),
    ...(intakeResult.clarifications.length > 0 && { clarifications: intakeResult.clarifications }),
  };
}
