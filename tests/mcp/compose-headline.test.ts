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

  it('row 2 — set size 0, cost > 0 (parentModel forgotten on a real-cost batch)', () => {
    const timings: BatchTimings = {
      wallClockMs: 45_000,
      sumOfTaskMs: 195_000,
      estimatedParallelSavingsMs: 150_000,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 7,
      completedTasks: 7,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 100.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0.09,
      totalSavedCostUSD: 0,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 7,
    };
    const taskSpecs = taskSpecsWithParent(7, undefined);

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '7 tasks, 7/7 ok (100.0%), wall 45s, saved ~2m 30s vs serial, $0.09 actual',
    );
  });

  it('row 3 — all-failed batch, set size 1, savedCostUSD = 0 (zero-saved edge)', () => {
    const timings: BatchTimings = {
      wallClockMs: 12_000,
      sumOfTaskMs: 47_000,
      estimatedParallelSavingsMs: 35_000,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 5,
      completedTasks: 0,
      incompleteTasks: 0,
      failedTasks: 5,
      successPercent: 0.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0.05,
      totalSavedCostUSD: 0,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    };
    const taskSpecs = taskSpecsWithParent(5, 'claude-opus-4-6');

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '5 tasks, 0/5 ok (0.0%), wall 12s, saved ~35s vs serial, $0.05 actual / $0.00 saved vs claude-opus-4-6 (1.0x ROI)',
    );
  });

  it('row 4 — multi-hour batch, set size 1, cost > 0 (hour-scale duration formatting)', () => {
    const timings: BatchTimings = {
      wallClockMs: 4_320_000,
      sumOfTaskMs: 14_220_000,
      estimatedParallelSavingsMs: 9_900_000,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 30,
      completedTasks: 28,
      incompleteTasks: 2,
      failedTasks: 0,
      successPercent: 93.3,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 18.05,
      totalSavedCostUSD: 34.73,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    };
    const taskSpecs = taskSpecsWithParent(30, 'claude-opus-4-6');

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '30 tasks, 28/30 ok (93.3%), wall 1h 12m, saved ~2h 45m vs serial, $18.05 actual / $34.73 saved vs claude-opus-4-6 (2.9x ROI)',
    );
  });

  it('row 5 — mixed parentModel batch, set size >= 2 (ROI multiplier suppressed)', () => {
    const timings: BatchTimings = {
      wallClockMs: 130_000,
      sumOfTaskMs: 530_000,
      estimatedParallelSavingsMs: 400_000,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 8,
      completedTasks: 8,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 100.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0.22,
      totalSavedCostUSD: 1.64,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    };
    const taskSpecs: Pick<TaskSpec, 'parentModel'>[] = [
      { parentModel: 'claude-opus-4-6' },
      { parentModel: 'claude-opus-4-6' },
      { parentModel: 'claude-opus-4-6' },
      { parentModel: 'claude-opus-4-6' },
      { parentModel: 'claude-sonnet-4-6' },
      { parentModel: 'claude-sonnet-4-6' },
      { parentModel: 'claude-sonnet-4-6' },
      { parentModel: 'claude-sonnet-4-6' },
    ];

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '8 tasks, 8/8 ok (100.0%), wall 2m 10s, saved ~6m 40s vs serial, $0.22 actual / $1.64 saved vs multiple baselines',
    );
  });

  it('row 6 — set size 0, cost = 0 (trivial / all-mocked, sub-minute)', () => {
    const timings: BatchTimings = {
      wallClockMs: 2_000,
      sumOfTaskMs: 4_500,
      estimatedParallelSavingsMs: 2_500,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 3,
      completedTasks: 3,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 100.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0,
      totalSavedCostUSD: 0,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 3,
    };
    const taskSpecs = taskSpecsWithParent(3, undefined);

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '3 tasks, 3/3 ok (100.0%), wall 2s, $0.00 actual',
    );
  });

  it('row 7 — set size 1, cost = 0 (divide-by-zero guard takes precedence)', () => {
    const timings: BatchTimings = {
      wallClockMs: 2_000,
      sumOfTaskMs: 4_500,
      estimatedParallelSavingsMs: 2_500,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 3,
      completedTasks: 3,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 100.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0,
      totalSavedCostUSD: 0,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    };
    const taskSpecs = taskSpecsWithParent(3, 'claude-opus-4-6');

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '3 tasks, 3/3 ok (100.0%), wall 2s, $0.00 actual',
    );
  });

  it('row 8 — set size >= 2, cost = 0 (divide-by-zero guard takes precedence)', () => {
    const timings: BatchTimings = {
      wallClockMs: 2_000,
      sumOfTaskMs: 4_500,
      estimatedParallelSavingsMs: 2_500,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 3,
      completedTasks: 3,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 100.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0,
      totalSavedCostUSD: 0,
      actualCostUnavailableTasks: 0,
      savedCostUnavailableTasks: 0,
    };
    const taskSpecs: Pick<TaskSpec, 'parentModel'>[] = [
      { parentModel: 'claude-opus-4-6' },
      { parentModel: 'claude-sonnet-4-6' },
      { parentModel: 'claude-opus-4-6' },
    ];

    expect(composeHeadline({ timings, batchProgress, aggregateCost, taskSpecs })).toBe(
      '3 tasks, 3/3 ok (100.0%), wall 2s, $0.00 actual',
    );
  });
});
