import { describe, it, expect } from 'vitest';
import { composeHeadline } from '../../packages/mcp/src/headline.js';
import type {
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
  TaskSpec,
} from '@zhixuan92/multi-model-agent-core';

/**
 * Make a throwaway TaskSpec[] where every task declares the same parentModel.
 * composeHeadline only reads `parentModel`, so we don't need real prompts/tiers.
 */
function taskSpecsWithParent(count: number, parentModel: string | undefined): Pick<TaskSpec, 'parentModel'>[] {
  return Array.from({ length: count }, () => ({ parentModel }));
}

describe('composeHeadline', () => {
  it('row 1 — round-3 Tally batch (single baseline, cost > 0, multi-minute wall clock)', () => {
    const timings: BatchTimings = {
      wallClockMs: 354_741,
      sumOfTaskMs: 1_466_478,
      estimatedParallelSavingsMs: 1_111_737,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 11,
      completedTasks: 5,
      incompleteTasks: 6,
      failedTasks: 0,
      successPercent: 45.5,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 1.37,
      totalSavedCostUSD: 8.91,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    };
    const taskSpecs = taskSpecsWithParent(11, 'claude-opus-4-6');

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '11 tasks, 5/11 ok (45.5%), wall 5m 54s, saved ~18m 31s vs serial, $1.37 actual / $8.91 saved vs claude-opus-4-6 (7.5x ROI)',
    );
  });
});
