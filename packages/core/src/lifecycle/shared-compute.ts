// packages/core/src/lifecycle/shared-compute.ts
// Shared computation helpers for executor output envelopes.
// These mirror the functions in packages/mcp/src/tools/batch-response.ts
// but live in core to avoid cross-package coupling in executors.
import type { RunResult } from '../types.js';
import type { BatchTimings, BatchAggregateCost } from './executor-output-types.js';

export function computeTimings(wallClockMs: number, results: RunResult[]): BatchTimings {
  const sumOfTaskMs = results.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const estimatedParallelSavingsMs = Math.max(0, sumOfTaskMs - wallClockMs);
  return { wallClockMs, sumOfTaskMs, estimatedParallelSavingsMs };
}

export function computeAggregateCost(results: RunResult[]): BatchAggregateCost {
  let totalActualCostUSD = 0;
  let totalCostDeltaVsMainUSD = 0;
  let anyCostFinite = false;

  for (const r of results) {
    // Sum across entered stages — same logic as terminal-handlers.ts:78-97
    // and task-completion-summary.ts:98. The top-level r.cost field is a
    // stale implementer-only reading and must NOT be used for the public
    // envelope's roll-up. (Bug observed 2026-05-10: r.cost was null in real
    // audit envelopes while stageStats[*].costUSD carried ~$2.06 / ~$3.71
    // per task.)
    const stageStats = (r.stageStats ?? {}) as Record<string, { entered?: boolean; costUSD?: number | null } | undefined>;
    for (const stage of Object.values(stageStats)) {
      if (!stage?.entered) continue;
      const c = stage.costUSD;
      if (typeof c === 'number' && Number.isFinite(c)) {
        totalActualCostUSD += c;
        anyCostFinite = true;
      }
    }

    if (r.cost?.costDeltaVsMainUSD !== null && r.cost?.costDeltaVsMainUSD !== undefined) {
      totalCostDeltaVsMainUSD += r.cost.costDeltaVsMainUSD;
    }
  }

  return {
    totalActualCostUSD: anyCostFinite ? totalActualCostUSD : 0,
    totalCostDeltaVsMainUSD,
  };
}
