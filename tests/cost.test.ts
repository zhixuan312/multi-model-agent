import { describe, it, expect } from 'vitest';
import { computeCostUSD } from '../packages/core/src/types.js';
import type { ProviderConfig } from '../packages/core/src/types.js';

describe('computeCostUSD', () => {
  const baseConfig: ProviderConfig = {
    type: 'codex',
    model: 'gpt-5-codex',
  };

  it('returns null when neither rate is configured', () => {
    expect(computeCostUSD(1_000_000, 500_000, baseConfig)).toBeNull();
  });

  it('returns null when only the input rate is configured', () => {
    const config: ProviderConfig = { ...baseConfig, inputCostPerMTok: 1.0 };
    expect(computeCostUSD(1_000, 1_000, config)).toBeNull();
  });

  it('returns null when only the output rate is configured', () => {
    const config: ProviderConfig = { ...baseConfig, outputCostPerMTok: 1.0 };
    expect(computeCostUSD(1_000, 1_000, config)).toBeNull();
  });

  it('computes cost with both rates set', () => {
    // 1M input @ $2 + 500k output @ $4 = $2 + $2 = $4
    const config: ProviderConfig = {
      ...baseConfig,
      inputCostPerMTok: 2,
      outputCostPerMTok: 4,
    };
    expect(computeCostUSD(1_000_000, 500_000, config)).toBeCloseTo(4, 6);
  });

  it('returns 0 deterministically when both rates are 0 (free provider)', () => {
    const config: ProviderConfig = {
      ...baseConfig,
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
    };
    expect(computeCostUSD(123_456, 789_012, config)).toBe(0);
  });

  it('handles small token counts proportionally', () => {
    // 100 input @ $3 + 50 output @ $6 = 0.0003 + 0.0003 = 0.0006
    const config: ProviderConfig = {
      ...baseConfig,
      inputCostPerMTok: 3,
      outputCostPerMTok: 6,
    };
    expect(computeCostUSD(100, 50, config)).toBeCloseTo(0.0006, 8);
  });

  it('returns null for non-finite rates', () => {
    const config = {
      ...baseConfig,
      inputCostPerMTok: Number.POSITIVE_INFINITY,
      outputCostPerMTok: 1,
    } as ProviderConfig;
    expect(computeCostUSD(1, 1, config)).toBeNull();
  });

  it('returns null for negative rates', () => {
    const config = {
      ...baseConfig,
      inputCostPerMTok: -1,
      outputCostPerMTok: 1,
    } as ProviderConfig;
    expect(computeCostUSD(1, 1, config)).toBeNull();
  });
});
