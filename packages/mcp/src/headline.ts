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

  // Parallel savings clause — omitted when single task or savings <= 0
  if (taskSpecs.length > 1 && timings.estimatedParallelSavingsMs > 0) {
    parts.push(`saved ~${formatDuration(timings.estimatedParallelSavingsMs)} vs serial`);
  }

  // Cost clause — single-baseline happy path only (row 1). Other branches in Task 2.
  const parentSet = new Set(
    taskSpecs
      .map((t) => t.parentModel)
      .filter((m): m is string => typeof m === 'string' && m.length > 0),
  );
  if (aggregateCost.totalActualCostUSD > 0 && parentSet.size === 1) {
    const parentLabel = [...parentSet][0];
    const ratio =
      (aggregateCost.totalActualCostUSD + aggregateCost.totalSavedCostUSD) /
      aggregateCost.totalActualCostUSD;
    parts.push(
      `${formatCurrency(aggregateCost.totalActualCostUSD)} actual / ${formatCurrency(aggregateCost.totalSavedCostUSD)} saved vs ${parentLabel} (${ratio.toFixed(1)}x ROI)`,
    );
  } else {
    parts.push(`${formatCurrency(aggregateCost.totalActualCostUSD)} actual`);
  }

  return parts.join(', ');
}
