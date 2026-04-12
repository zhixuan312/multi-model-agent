import { describe, it, expect } from 'vitest';
import { computeNormalizationBudget } from '@zhixuan92/multi-model-agent-core/readiness/normalization-budget';

describe('computeNormalizationBudget', () => {
  it('returns $0.01 flat when maxCostUSD is undefined', () => {
    expect(computeNormalizationBudget(undefined)).toBe(0.01);
  });
  it('returns $0.01 when 20% > $0.01', () => {
    expect(computeNormalizationBudget(0.05)).toBe(0.01);
  });
  it('returns 20% when that is smaller than $0.01', () => {
    expect(computeNormalizationBudget(0.02)).toBeCloseTo(0.004, 5);
  });
  it('caps at $0.01 for very large maxCostUSD', () => {
    expect(computeNormalizationBudget(100)).toBe(0.01);
  });
  it('handles 0', () => {
    expect(computeNormalizationBudget(0)).toBe(0);
  });
});
