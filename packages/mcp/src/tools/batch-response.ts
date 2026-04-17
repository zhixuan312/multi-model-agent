import type {
  RunResult,
  TaskSpec,
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

/**
 * Build a fan-out response for specialized tools. No batchId (not cache-backed).
 */
export function buildFanOutResponse(
  results: RunResult[],
  tasks: TaskSpec[],
  wallClockMs: number,
): { type: 'text'; text: string } {
  const timings = computeTimings(wallClockMs, results);
  const batchProgress = computeBatchProgress(results);
  const aggregateCost = computeAggregateCost(results);

  return {
    type: 'text' as const,
    text: JSON.stringify({
      schemaVersion: '1.0.0',
      mode: 'fan_out',
      timings,
      batchProgress,
      aggregateCost,
      results: results.map((r, i) => ({
        agentType: tasks[i]?.agentType ?? '(auto)',
        status: r.status,
        output: r.output,
        turns: r.turns,
        durationMs: r.durationMs,
        filesRead: r.filesRead,
        filesWritten: r.filesWritten,
        directoriesListed: r.directoriesListed,
        toolCalls: r.toolCalls,
        escalationLog: r.escalationLog,
        usage: r.usage,
        terminationReason: r.terminationReason,
        specReviewStatus: r.specReviewStatus,
        qualityReviewStatus: r.qualityReviewStatus,
        agents: r.agents,
        models: r.models,
        ...(r.error && { error: r.error }),
      })),
    }, null, 2),
  };
}