// packages/core/src/executors/retry.ts
import type { ExecutionContext, ExecutorOutput } from './types.js';
import type { Input } from '../tool-schemas/retry.js';
import type { TaskSpec } from '../types.js';
import { runTasks } from '../run-tasks.js';
import { computeTimings, computeAggregateCost } from './shared-compute.js';
import { notApplicable } from '../reporting/not-applicable.js';

// --- Ported from the inline retry_tasks registration in packages/mcp/src/cli.ts ---

export interface RetryOptions {
  /**
   * Injects harness-level defaults (tools, timeoutMs, cwd, etc.) into each TaskSpec.
   * Provided by the MCP layer.
   */
  injectDefaults: (tasks: TaskSpec[]) => TaskSpec[];
  /**
   * Optional override for `runTasks` — used in tests to inject a mock implementation.
   */
  runTasksOverride?: typeof runTasks;
}

export interface RetryOutput extends ExecutorOutput {
  retryBatchId: string;
}

export async function executeRetry(
  ctx: ExecutionContext,
  input: Input,
  options: RetryOptions,
): Promise<RetryOutput> {
  const { config, projectContext, contextBlockStore } = ctx;
  const { batchCache } = projectContext;
  const { injectDefaults } = options;
  const runTasksImpl = options.runTasksOverride ?? runTasks;

  const batch = batchCache.get(input.batchId);
  if (!batch) {
    throw new Error(
      `batch "${input.batchId}" is unknown or expired — re-dispatch with full task specs via delegate_tasks`,
    );
  }
  // Mark this batch as recently used so the LRU eviction does not
  // drop a hot entry when newer batches arrive. Does NOT refresh TTL.
  batchCache.touch(input.batchId);
  for (const i of input.taskIndices) {
    if (i < 0 || i >= batch.tasks.length) {
      throw new Error(
        `index ${i} is out of range for batch ${input.batchId} (size ${batch.tasks.length})`,
      );
    }
  }
  const subset = input.taskIndices.map((i) => batch.tasks[i]);

  // Create a fresh batch for the retried tasks so the original batch
  // entry is preserved and get_batch_slice can still retrieve it.
  const retryBatchId = batchCache.remember(subset);

  const batchStartMs = Date.now();
  let results: import('../types.js').RunResult[] = [];
  let retryAborted = false;
  try {
    results = await runTasksImpl(injectDefaults(subset), config, {
      runtime: { contextBlockStore },
    });
  } catch (err) {
    retryAborted = true;
    throw err;
  } finally {
    if (retryAborted) {
      try { batchCache.abort(retryBatchId); } catch { /* already terminal */ }
    } else {
      try { batchCache.complete(retryBatchId, results); } catch { /* already terminal */ }
    }
  }
  const wallClockMs = Date.now() - batchStartMs;

  const batchTimings = computeTimings(wallClockMs, results);
  const costSummary = computeAggregateCost(results);
  const parentModel = ctx.parentModel ?? config.defaults?.parentModel ?? undefined;

  return {
    headline: '',
    results,
    batchTimings,
    costSummary,
    structuredReport: notApplicable('no structured report emitted by this executor'),
    error: notApplicable('batch succeeded'),
    proposedInterpretation: notApplicable('batch not awaiting clarification'),
    batchId: retryBatchId,
    retryBatchId,
    wallClockMs,
    parentModel,
  };
}
