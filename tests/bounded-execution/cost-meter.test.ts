import { describe, it, expect } from 'vitest';
import { CostMeter } from '../../packages/core/src/bounded-execution/cost-meter.js';

describe('CostMeter', () => {
  const pricing = { inputUSDPerMillion: 3, outputUSDPerMillion: 15, cachedReadUSDPerMillion: 0.3, cachedNonReadUSDPerMillion: 3.75 };

  it('accumulates usage and calculates actual cost', () => {
    const m = new CostMeter();
    m.accumulate({ inputTokens: 1_000_000, outputTokens: 100_000, cachedReadTokens: 50_000, cachedNonReadTokens: 10_000 });
    const { actualCostUSD } = m.calculate(pricing);
    expect(actualCostUSD).toBeCloseTo(3 + 1.5 + 0.015 + 0.0375, 5);
  });

  it('computes delta between prior and current', () => {
    const m = new CostMeter();
    expect(m.delta({ actualCostUSD: 1.0 }, { actualCostUSD: 1.5 })).toBeCloseTo(0.5);
  });
});
