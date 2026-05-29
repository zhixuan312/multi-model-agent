import { describe, it, expect } from 'bun:test';
import { priceTokens, subtractTokens, type RateCard } from '../../packages/core/src/bounded-execution/cost-compute.js';
import type { TokenUsage } from '../../packages/core/src/providers/runner-types.js';

const card: RateCard = {
  inputCostPerMTok: 5,
  outputCostPerMTok: 25,
  cachedReadCostPerMTok: 0.5,
  cachedNonReadCostPerMTok: 6.25,
};

const zero: TokenUsage = {
  inputTokens: 0, outputTokens: 0,
  cachedReadTokens: 0, cachedNonReadTokens: 0,
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
  it('only cachedNonReadTokens at $6.25/M', () => {
    expect(priceTokens({ ...zero, cachedNonReadTokens: 1_000_000 }, card)).toBeCloseTo(6.25, 10);
  });
  it('only outputTokens at $25/M', () => {
    expect(priceTokens({ ...zero, outputTokens: 1_000_000 }, card)).toBeCloseTo(25, 10);
  });
  it('mixed = sum of contributions', () => {
    const t: TokenUsage = {
      inputTokens: 100_000, outputTokens: 50_000,
      cachedReadTokens: 1_000_000, cachedNonReadTokens: 200_000,
    };
    // 0.5 + 1.25 + 0.5 + 1.25 = 3.5
    expect(priceTokens(t, card)).toBeCloseTo(3.5, 10);
  });
});

describe('subtractTokens', () => {
  it('computes per-field delta, clamped at zero', () => {
    const cur: TokenUsage = { inputTokens: 200, outputTokens: 100, cachedReadTokens: 50, cachedNonReadTokens: 0 };
    const prev: TokenUsage = { inputTokens: 100, outputTokens: 60, cachedReadTokens: 30, cachedNonReadTokens: 0 };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(100);
    expect(d.outputTokens).toBe(40);
    expect(d.cachedReadTokens).toBe(20);
    expect(d.cachedNonReadTokens).toBe(0);
  });

  it('clamps single-field regression to 0', () => {
    const cur: TokenUsage = { inputTokens: 100, outputTokens: 80, cachedReadTokens: 5, cachedNonReadTokens: 0 };
    const prev: TokenUsage = { inputTokens: 120, outputTokens: 60, cachedReadTokens: 3, cachedNonReadTokens: 0 };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(0);
    expect(d.outputTokens).toBe(20);
    expect(d.cachedReadTokens).toBe(2);
  });

  it('detects counter reset when all fields decrease', () => {
    const cur: TokenUsage = { inputTokens: 50, outputTokens: 30, cachedReadTokens: 10, cachedNonReadTokens: 0 };
    const prev: TokenUsage = { inputTokens: 500, outputTokens: 300, cachedReadTokens: 100, cachedNonReadTokens: 0 };
    const d = subtractTokens(cur, prev);
    // All fields decreased → treat cur as full delta (counter reset)
    expect(d.inputTokens).toBe(50);
    expect(d.outputTokens).toBe(30);
    expect(d.cachedReadTokens).toBe(10);
  });

  it('returns zero delta when cur === prev', () => {
    const cur: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedReadTokens: 20, cachedNonReadTokens: 0 };
    const d = subtractTokens(cur, cur);
    expect(d.inputTokens).toBe(0);
    expect(d.outputTokens).toBe(0);
    expect(d.cachedReadTokens).toBe(0);
  });
});
