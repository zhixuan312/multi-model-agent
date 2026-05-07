// packages/core/src/executors/shared-compute.ts
// Shared computation helpers for executor output envelopes.
// These mirror the functions in packages/mcp/src/tools/batch-response.ts
// but live in core to avoid cross-package coupling in executors.
import type { RunResult } from '../../types.js';
import type { BatchTimings, BatchAggregateCost } from '../executor-output-types.js';

export function computeTimings(wallClockMs: number, results: RunResult[]): BatchTimings {
  const sumOfTaskMs = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const estimatedParallelSavingsMs = Math.max(0, sumOfTaskMs - wallClockMs);
  return { wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs };
}

export function computeAggregateCost(results: RunResult[]): BatchAggregateCost {
  let totalActualCostUSD = 0;
  let totalCostDeltaVsParentUSD = 0;
  for (const r of results) {
    if (r.cost?.costUSD !== null && r.cost?.costUSD !== undefined) {
      totalActualCostUSD += r.cost.costUSD;
    }
    if (r.cost?.costDeltaVsParentUSD !== null && r.cost?.costDeltaVsParentUSD !== undefined) {
      totalCostDeltaVsParentUSD += r.cost.costDeltaVsParentUSD;
    }
  }
  return { totalActualCostUSD, totalCostDeltaVsParentUSD };
}
