import { describe, it, expect } from 'vitest';
import { computeAggregateCost } from '../../packages/core/src/lifecycle/shared-compute.js';

// Minimal RunResult-shaped fixture. Only the fields computeAggregateCost
// reads matter. We deliberately do NOT set top-level `cost.costUSD` to
// prove the new code reads from stageStats only.
function makeResult(opts: { stageCosts: Array<{ entered: boolean; costUSD: number | null }> }): any {
  const stageStats: Record<string, any> = {};
  opts.stageCosts.forEach((s, i) => {
    stageStats[`stage_${i}`] = { entered: s.entered, costUSD: s.costUSD };
  });
  return { stageStats };
}

describe('computeAggregateCost (A11 fix — sums from stageStats)', () => {
  it('sums entered stages with finite costUSD', () => {
    const r = computeAggregateCost([
      makeResult({ stageCosts: [
        { entered: true, costUSD: 2.038865 },
        { entered: true, costUSD: 0.020634 },
      ]}),
    ]);
    expect(r.totalActualCostUSD).toBeCloseTo(2.059499, 6);
  });

  it('skips non-entered stages even when they carry a cost', () => {
    const r = computeAggregateCost([
      makeResult({ stageCosts: [
        { entered: true,  costUSD: 1.0 },
        { entered: false, costUSD: 99.0 },  // skipped
      ]}),
    ]);
    expect(r.totalActualCostUSD).toBeCloseTo(1.0, 6);
  });

  it('skips null/non-finite costs silently', () => {
    const r = computeAggregateCost([
      makeResult({ stageCosts: [
        { entered: true, costUSD: 0.5 },
        { entered: true, costUSD: null },
        { entered: true, costUSD: NaN as unknown as number },
      ]}),
    ]);
    expect(r.totalActualCostUSD).toBeCloseTo(0.5, 6);
  });

  it('returns 0 (honest-zero) when every stage has null cost (mock provider)', () => {
    const r = computeAggregateCost([
      makeResult({ stageCosts: [
        { entered: true, costUSD: null },
        { entered: true, costUSD: null },
      ]}),
    ]);
    expect(r.totalActualCostUSD).toBe(0);
  });

  it('sums across multiple results in the batch', () => {
    const r = computeAggregateCost([
      makeResult({ stageCosts: [{ entered: true, costUSD: 1.0 }] }),
      makeResult({ stageCosts: [{ entered: true, costUSD: 2.0 }] }),
      makeResult({ stageCosts: [{ entered: true, costUSD: 3.0 }] }),
    ]);
    expect(r.totalActualCostUSD).toBeCloseTo(6.0, 6);
  });

  it('regression for the 2026-05-10 spec audit envelope', () => {
    // Real values from /tmp/spec_audit_envelope.json. Pre-fix: returns 0.
    const r = computeAggregateCost([
      makeResult({ stageCosts: [
        { entered: true, costUSD: 2.038865 },     // implementing
        { entered: true, costUSD: 0.020634 },     // quality_review
      ]}),
    ]);
    expect(r.totalActualCostUSD).toBeGreaterThan(2);  // would fail at 0 pre-fix
  });
});
