import type {
  RunResult,
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
} from '@zhixuan92/multi-model-agent-core';

/**
 * Compute per-batch timing metrics.
 */
export function computeTimings(wallClockMs: number, results: RunResult[]): BatchTimings {
  const sumOfTaskMs = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const estimatedParallelSavingsMs = Math.max(0, sumOfTaskMs - wallClockMs);
  return { wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs };
}

/**
 * Compute per-batch progress summary.
 */
export function computeBatchProgress(results: RunResult[]): BatchProgress {
  const totalTasks = results.length;
  const completedTasks = results.filter((r) => r.status === 'ok').length;
  const incompleteTasks = results.filter(
    (r) => r.status === 'incomplete' || r.status === 'timeout',
  ).length;
  const failedTasks = results.filter(
    (r) =>
      r.status === 'error' ||
      r.status === 'api_aborted' ||
      r.status === 'api_error' ||
      r.status === 'network_error',
  ).length;
  const successPercent =
    totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 1000) / 10;
  return { totalTasks, completedTasks, incompleteTasks, failedTasks, successPercent };
}

/**
 * Compute aggregate cost across all tasks.
 */
export function computeAggregateCost(results: RunResult[]): BatchAggregateCost {
  let totalActualCostUSD = 0;
  let totalSavedCostUSD = 0;

  for (const r of results) {
    if (r.usage.costUSD !== null && r.usage.costUSD !== undefined) {
      totalActualCostUSD += r.usage.costUSD;
    }
    if (r.usage.savedCostUSD !== null && r.usage.savedCostUSD !== undefined) {
      totalSavedCostUSD += r.usage.savedCostUSD;
    }
  }

  return {
    totalActualCostUSD,
    totalSavedCostUSD,
  };
}

