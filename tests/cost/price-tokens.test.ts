import { describe, it, expect } from 'vitest';
import { priceTokens, subtractTokens, type RateCard, type TokenCounts } from '../../packages/core/src/cost/compute.js';

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

describe('subtractTokens', () => {
  it('computes per-field delta, clamped at zero', () => {
    const cur: TokenCounts = { inputTokens: 200, outputTokens: 100, cachedReadTokens: 50, cachedCreationTokens: 0, reasoningTokens: 0 };
    const prev: TokenCounts = { inputTokens: 100, outputTokens: 60, cachedReadTokens: 30, cachedCreationTokens: 0, reasoningTokens: 0 };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(100);
    expect(d.outputTokens).toBe(40);
    expect(d.cachedReadTokens).toBe(20);
    expect(d.cachedCreationTokens).toBe(0);
    expect(d.reasoningTokens).toBe(0);
  });

  it('clamps single-field regression to 0', () => {
    const cur: TokenCounts = { inputTokens: 100, outputTokens: 80, cachedReadTokens: 5, cachedCreationTokens: 0, reasoningTokens: 0 };
    const prev: TokenCounts = { inputTokens: 120, outputTokens: 60, cachedReadTokens: 3, cachedCreationTokens: 0, reasoningTokens: 0 };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(0);
    expect(d.outputTokens).toBe(20);
    expect(d.cachedReadTokens).toBe(2);
  });

  it('detects counter reset when all fields decrease', () => {
    const cur: TokenCounts = { inputTokens: 50, outputTokens: 30, cachedReadTokens: 10, cachedCreationTokens: 0, reasoningTokens: 0 };
    const prev: TokenCounts = { inputTokens: 500, outputTokens: 300, cachedReadTokens: 100, cachedCreationTokens: 0, reasoningTokens: 0 };
    const d = subtractTokens(cur, prev);
    // All fields decreased → treat cur as full delta (counter reset)
    expect(d.inputTokens).toBe(50);
    expect(d.outputTokens).toBe(30);
    expect(d.cachedReadTokens).toBe(10);
  });

  it('returns zero delta when cur === prev', () => {
    const cur: TokenCounts = { inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedCreationTokens: 0, reasoningTokens: 0 };
    const d = subtractTokens(cur, cur);
    expect(d.inputTokens).toBe(0);
    expect(d.outputTokens).toBe(0);
    expect(d.cachedReadTokens).toBe(0);
  });
});
