import { describe, it, expect } from 'vitest';
import { computeTaskCompletionSummary, formatTaskDoneLine } from '../../packages/core/src/run-tasks/task-completion-summary.js';
import { richRunResult } from '../contract/telemetry/fixtures/rich-runresult.js';

describe('TaskCompletionSummary', () => {
  it('computes the same numbers buildTaskCompletedEvent uses for top-level totals', () => {
    const rr = richRunResult();
    const sum = computeTaskCompletionSummary({ runResult: rr, taskIndexZero: 0, totalTasks: 1, batchId: '94fc50cc-...' });
    // Stage costs in fixture: impl 0.03 + spec_review 0.005 + quality_review 0.005
    // + spec_rework 0.003 + quality_rework 0.003 + diff_review 0.001
    // + verifying 0.001 + committing 0.001 = 0.049
    expect(sum.totalCostUSD).toBeCloseTo(0.049, 6);
    expect(sum.totalInputTokens).toBeGreaterThan(0);
    expect(sum.terminalStatus).toBe('ok');
  });

  it('formatTaskDoneLine renders the canonical end-of-task summary string', () => {
    const rr = richRunResult();
    const sum = computeTaskCompletionSummary({ runResult: rr, taskIndexZero: 0, totalTasks: 2, batchId: '94fc50cc' });
    const line = formatTaskDoneLine(sum);
    expect(line).toMatch(/^\[mmagent\] batch=94fc50cc task=1\/2 taskIndex=0 done: ok in /);
    expect(line).toContain(' tokens, $');
    expect(line).toContain('reviews [spec=approved, quality=approved]');
  });

  it('renders unknown placeholders when no entered stage has finite token/cost values', () => {
    const rr = richRunResult();
    rr.usage = undefined as any;
    // Null out token/cost on every entered stage — the summary derives from
    // stage stats (not runResult.usage), so partial nulls are not enough.
    for (const s of Object.values(rr.stageStats!)) {
      const stage = s as { entered: boolean; inputTokens: number | null; outputTokens: number | null; costUSD: number | null };
      if (!stage.entered) continue;
      stage.inputTokens = null;
      stage.outputTokens = null;
      stage.costUSD = null;
    }
    const sum = computeTaskCompletionSummary({ runResult: rr, taskIndexZero: 0, totalTasks: 1, batchId: 'abc' });
    const line = formatTaskDoneLine(sum);
    expect(line).toContain('tokens=unknown');
    expect(line).toContain('$unknown');
  });

  it('uses exact integer for tokens below 1000 and <int>k otherwise', () => {
    expect(formatTaskDoneLine({ ...baseSum(), totalInputTokens: 342, totalOutputTokens: 0 } as any)).toContain('342 tokens');
    expect(formatTaskDoneLine({ ...baseSum(), totalInputTokens: 11500, totalOutputTokens: 500 } as any)).toContain('12k tokens');
  });
});

function baseSum() {
  return {
    batchId: 'abc', taskIndexZero: 0, totalTasks: 1,
    terminalStatus: 'ok', totalDurationMs: 1000, totalCostUSD: 0.001,
    totalInputTokens: 0, totalOutputTokens: 0, turns: 0,
    filesWrittenCount: 0, specReviewVerdict: 'not_applicable', qualityReviewVerdict: 'approved',
  };
}
