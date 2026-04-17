import { describe, it, expect } from 'vitest';
import { composeHeadline } from '@zhixuan92/multi-model-agent-mcp';
import type {
  BatchTimings,
  BatchProgress,
  BatchAggregateCost,
} from '@zhixuan92/multi-model-agent-core';

describe('composeHeadline', () => {
  it('single parent model — shows savings and ROI', () => {
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
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost, parentModel: 'claude-opus-4-6' })).toBe(
      '11 tasks, 5/11 ok (45.5%), wall 5m 54s, saved ~18m 31s vs serial, $8.91 saved vs claude-opus-4-6 (7.5x ROI)',
    );
  });

  it('no parent model — shows actual cost only', () => {
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
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost })).toBe(
      '7 tasks, 7/7 ok (100.0%), wall 45s, saved ~2m 30s vs serial, $0.09 actual',
    );
  });

  it('parent model with zero saved — shows 1.0x ROI', () => {
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
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost, parentModel: 'claude-opus-4-6' })).toBe(
      '5 tasks, 0/5 ok (0.0%), wall 12s, saved ~35s vs serial, $0.00 saved vs claude-opus-4-6 (1.0x ROI)',
    );
  });

  it('hour-scale duration formatting', () => {
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
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost, parentModel: 'claude-opus-4-6' })).toBe(
      '30 tasks, 28/30 ok (93.3%), wall 1h 12m, saved ~2h 45m vs serial, $34.73 saved vs claude-opus-4-6 (2.9x ROI)',
    );
  });

  it('zero cost, no parent model — $0.00 actual', () => {
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
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost })).toBe(
      '3 tasks, 3/3 ok (100.0%), wall 2s, $0.00 actual',
    );
  });

  it('zero cost, parent model set — divide-by-zero guard shows $0.00 actual', () => {
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
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost, parentModel: 'claude-opus-4-6' })).toBe(
      '3 tasks, 3/3 ok (100.0%), wall 2s, $0.00 actual',
    );
  });

  it('single task — omits parallel savings clause', () => {
    const timings: BatchTimings = {
      wallClockMs: 10_000,
      sumOfTaskMs: 10_000,
      estimatedParallelSavingsMs: 0,
    };
    const batchProgress: BatchProgress = {
      totalTasks: 1,
      completedTasks: 1,
      incompleteTasks: 0,
      failedTasks: 0,
      successPercent: 100.0,
    };
    const aggregateCost: BatchAggregateCost = {
      totalActualCostUSD: 0.50,
      totalSavedCostUSD: 3.20,
    };

    expect(composeHeadline({ timings, batchProgress, aggregateCost, parentModel: 'claude-opus-4-6' })).toBe(
      '1 tasks, 1/1 ok (100.0%), wall 10s, $3.20 saved vs claude-opus-4-6 (7.4x ROI)',
    );
  });
});
