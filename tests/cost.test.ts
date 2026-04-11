import { describe, it, expect } from 'vitest';
import { computeCostUSD, computeSavedCostUSD } from '../packages/core/src/types.js';
import type { ProviderConfig } from '../packages/core/src/types.js';

describe('computeCostUSD', () => {
  const baseConfig: ProviderConfig = {
    type: 'codex',
    model: 'llama-3-70b',
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

  it('falls back to the model profile when explicit rates are missing', () => {
    const config: ProviderConfig = {
      type: 'claude',
      model: 'claude-sonnet-4-5',
    };

    expect(computeCostUSD(1_000_000, 500_000, config)).toBeCloseTo(10.5, 6);
  });

  it('keeps provider-config rates ahead of the model profile', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'gpt-5-codex',
      inputCostPerMTok: 2,
      outputCostPerMTok: 20,
    };

    expect(computeCostUSD(1_000_000, 500_000, config)).toBeCloseTo(12, 6);
  });

  it('returns null for an unrated profile with no explicit config rates', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'MiniMax-M2',
    };

    expect(computeCostUSD(1_000_000, 500_000, config)).toBeNull();
  });
});

describe('computeSavedCostUSD', () => {
  it('returns null when the parent model is undefined', () => {
    expect(computeSavedCostUSD(1, 1, 1, undefined)).toBeNull();
  });

  it('returns null when the actual cost is unavailable', () => {
    expect(computeSavedCostUSD(null, 1, 1, 'gpt-5-codex')).toBeNull();
  });

  it('returns null when the parent profile has no rates', () => {
    expect(computeSavedCostUSD(1, 1_000, 1_000, 'MiniMax-M2')).toBeNull();
  });

  it('computes savings against a cheaper parent profile', () => {
    const actualCostUSD = 4;
    const inputTokens = 1_000_000;
    const outputTokens = 500_000;

    expect(computeSavedCostUSD(actualCostUSD, inputTokens, outputTokens, 'claude-opus-4-6')).toBeCloseTo(48.5, 6);
  });

  it('returns a negative value when the actual cost exceeds the parent profile cost', () => {
    const actualCostUSD = 20;
    const inputTokens = 1_000_000;
    const outputTokens = 0;

    expect(computeSavedCostUSD(actualCostUSD, inputTokens, outputTokens, 'gpt-5-codex')).toBeCloseTo(-18.75, 6);
  });
});
