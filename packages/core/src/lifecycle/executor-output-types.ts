import type { RunResult, ReviewVerdict } from '../types.js';
import type { NotApplicable } from '../reporting/not-applicable.js';

/** Aggregate timing metrics for a `delegate_tasks` batch. */
export interface BatchTimings {
  wallClockMs: number
  sumOfTaskMs: number
  estimatedParallelSavingsMs: number
}

/** Aggregate completion counts for a `delegate_tasks` batch. */
export interface BatchProgress {
  totalTasks: number
  completedTasks: number
  incompleteTasks: number
  failedTasks: number
  successPercent: number;
}

/** Aggregate cost metrics for a `delegate_tasks` batch. */
export interface BatchAggregateCost {
  totalActualCostUSD: number
  totalCostDeltaVsParentUSD: number
}

/**
 * Uniform output envelope returned by every executor.
 * Required shape for GET /batch/:id?taskIndex=N slicing (see spec §6.5).
 *
 * All 7 top-level envelope fields are required. Fields that are not
 * applicable for a given executor or code path are set to NotApplicable
 * via `notApplicable(reason)` rather than being omitted. Additional
 * passthrough fields (batchId, contextBlockId, etc.) are preserved
 * alongside the envelope.
 */
export interface ExecutorOutput {
  headline: string;
  results: RunResult[] | NotApplicable;
  batchTimings: BatchTimings | NotApplicable;
  costSummary: BatchAggregateCost | NotApplicable;
  structuredReport: Record<string, unknown> | NotApplicable;
  error: { code: string; message: string; details?: unknown } | NotApplicable;
  batchId: string;
  contextBlockId?: string;
  wallClockMs?: number;
  mainModel?: string;
  specReviewVerdict?: ReviewVerdict;
  qualityReviewVerdict?: ReviewVerdict;
  roundsUsed?: number;
}
