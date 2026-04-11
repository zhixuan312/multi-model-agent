import type {
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
  TaskSpec,
} from '@zhixuan92/multi-model-agent-core';

/**
 * Input for {@link composeHeadline}. `taskSpecs` is passed so the function can
 * derive the `parentModel` label internally (set of distinct non-null values
 * across the batch — see spec §1). Callers do not pre-compute the label.
 */
export interface ComposeHeadlineInput {
  timings: BatchTimings;
  batchProgress: BatchProgress;
  aggregateCost: BatchAggregateCost;
  taskSpecs: Pick<TaskSpec, 'parentModel'>[];
}

/**
 * Format a USD amount as `$X.YZ` — two decimals, no trailing-zero trimming
 * beyond two. Matches the currency-rendering rule in spec §1.
 */
export function formatCurrency(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a duration in ms using unit-aware human-readable rules:
 *   d <  1m  → "Ns"             (sub-minute: seconds only)
 *   1m ≤ d < 1h → "Nm Ns"       (minute-scale: minutes and seconds, no zero-pad)
 *   d ≥  1h → "Nh Nm"           (hour-scale: hours and minutes, seconds dropped)
 * Seconds are truncated (Math.floor) to avoid overstating wall-clock.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const s = totalSeconds - totalMinutes * 60;
    return `${totalMinutes}m ${s}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const m = totalMinutes - hours * 60;
  return `${hours}h ${m}m`;
}

/**
 * Compose the one-line ROI headline. See spec §1 for the decision table.
 */
export function composeHeadline(input: ComposeHeadlineInput): string {
  const { timings, batchProgress, aggregateCost, taskSpecs } = input;
  const parts: string[] = [];

  // Task count + success rate
  parts.push(
    `${batchProgress.totalTasks} tasks, ${batchProgress.completedTasks}/${batchProgress.totalTasks} ok (${batchProgress.successPercent.toFixed(1)}%)`,
  );

  // Wall clock
  parts.push(`wall ${formatDuration(timings.wallClockMs)}`);

  // Divide-by-zero guard — before any other cost or savings clause.
  // If totalActualCostUSD === 0, we collapse to "$0.00 actual" regardless
  // of parentModel set size (rows 6, 7, 8). This check must come BEFORE the
  // parallel savings clause so we don't emit "saved ~Xs" for zero-cost batches.
  if (aggregateCost.totalActualCostUSD === 0) {
    parts.push(`${formatCurrency(aggregateCost.totalActualCostUSD)} actual`);
    return parts.join(', ');
  }

  // Parallel savings clause — omitted when single task or savings <= 0
  if (taskSpecs.length > 1 && timings.estimatedParallelSavingsMs > 0) {
    parts.push(`saved ~${formatDuration(timings.estimatedParallelSavingsMs)} vs serial`);
  }

  // Cost clause — six-branch decision table from spec §1.
  const parentSet = new Set(
    taskSpecs
      .map((t) => t.parentModel)
      .filter((m): m is string => typeof m === 'string' && m.length > 0),
  );

  if (parentSet.size === 0) {
    // Row 2: no parentModel declared, positive cost. Show actual only.
    parts.push(`${formatCurrency(aggregateCost.totalActualCostUSD)} actual`);
  } else if (parentSet.size === 1) {
    // Rows 1, 3, 4: single baseline, positive cost. Emit full clause with ROI.
    const parentLabel = [...parentSet][0];
    const ratio =
      (aggregateCost.totalActualCostUSD + aggregateCost.totalSavedCostUSD) /
      aggregateCost.totalActualCostUSD;
    parts.push(
      `${formatCurrency(aggregateCost.totalActualCostUSD)} actual / ${formatCurrency(aggregateCost.totalSavedCostUSD)} saved vs ${parentLabel} (${ratio.toFixed(1)}x ROI)`,
    );
  } else {
    // Row 5: mixed baselines, positive cost. ROI multiplier is NOT coherent
    // across different parent baselines (different denominators), so we drop
    // it. The $saved number is still valid as an additive dollar quantity.
    parts.push(
      `${formatCurrency(aggregateCost.totalActualCostUSD)} actual / ${formatCurrency(aggregateCost.totalSavedCostUSD)} saved vs multiple baselines`,
    );
  }

  return parts.join(', ');
}
