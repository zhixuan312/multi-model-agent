import { describe, it, expect } from 'vitest';
import { priceTokens, type RateCard, type TokenCounts } from '../../packages/core/src/cost/compute.js';

const card: RateCard = {
  inputCostPerMTok: 5,
  outputCostPerMTok: 25,
  cachedReadCostPerMTok: 0.5,
  cachedCreationCostPerMTok: 6.25,
  reasoningCostPerMTok: 25,
};

const zero: TokenCounts = {
  inputTokens: 0, outputTokens: 0,
  cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
};

describe('priceTokens', () => {
  it('zero tokens → 0', () => {
    expect(priceTokens(zero, card)).toBe(0);
  });
  it('only inputTokens at $5/M', () => {
    expect(priceTokens({ ...zero, inputTokens: 1_000_000 }, card)).toBeCloseTo(5, 10);
  });
  it('only cachedReadTokens at $0.50/M', () => {
    expect(priceTokens({ ...zero, cachedReadTokens: 1_000_000 }, card)).toBeCloseTo(0.5, 10);
  });
  it('only cachedCreationTokens at $6.25/M', () => {
    expect(priceTokens({ ...zero, cachedCreationTokens: 1_000_000 }, card)).toBeCloseTo(6.25, 10);
  });
  it('only outputTokens at $25/M', () => {
    expect(priceTokens({ ...zero, outputTokens: 1_000_000 }, card)).toBeCloseTo(25, 10);
  });
  it('only reasoningTokens at $25/M', () => {
    expect(priceTokens({ ...zero, reasoningTokens: 1_000_000 }, card)).toBeCloseTo(25, 10);
  });
  it('mixed = sum of contributions', () => {
    const t: TokenCounts = {
      inputTokens: 100_000, outputTokens: 50_000,
      cachedReadTokens: 1_000_000, cachedCreationTokens: 200_000, reasoningTokens: 0,
    };
    // 0.5 + 1.25 + 0.5 + 1.25 = 3.5
    expect(priceTokens(t, card)).toBeCloseTo(3.5, 10);
  });
});
