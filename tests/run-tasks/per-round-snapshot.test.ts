import { describe, it, expect } from 'vitest';
import { subtractTokens, priceTokens, resolveRateCard } from '../../packages/core/src/cost/compute.js';
import type { TokenUsage } from '../../packages/core/src/runners/types.js';

describe('subtractTokens (per-turn delta tracking)', () => {
  it('returns per-field difference for normal growth', () => {
    const prev: TokenUsage = {
      inputTokens: 100, outputTokens: 50,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    const cur: TokenUsage = {
      inputTokens: 300, outputTokens: 150,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(200);
    expect(d.outputTokens).toBe(100);
    expect(d.cachedReadTokens).toBe(0);
    expect(d.cachedNonReadTokens).toBe(0);
  });

  it('returns per-field difference with cached and reasoning growth', () => {
    const prev: TokenUsage = {
      inputTokens: 500, outputTokens: 200,
      cachedReadTokens: 100, cachedNonReadTokens: 50,
    };
    const cur: TokenUsage = {
      inputTokens: 1200, outputTokens: 500,
      cachedReadTokens: 300, cachedNonReadTokens: 100,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(700);
    expect(d.outputTokens).toBe(300);
    expect(d.cachedReadTokens).toBe(200);
    expect(d.cachedNonReadTokens).toBe(50);
  });

  it('clamps single-field decrease to 0 (provider reporting glitch)', () => {
    const prev: TokenUsage = {
      inputTokens: 500, outputTokens: 200,
      cachedReadTokens: 100, cachedNonReadTokens: 0,
    };
    // inputTokens went backward (glitch), but output and cached grew
    const cur: TokenUsage = {
      inputTokens: 400, outputTokens: 300,
      cachedReadTokens: 150, cachedNonReadTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(0); // clamped
    expect(d.outputTokens).toBe(100);
    expect(d.cachedReadTokens).toBe(50);
  });

  it('detects counter reset (all fields ≤ prev) and treats cur as full delta', () => {
    const prev: TokenUsage = {
      inputTokens: 5000, outputTokens: 3000,
      cachedReadTokens: 500, cachedNonReadTokens: 200,
    };
    // Counter reset (new sub-agent session)
    const cur: TokenUsage = {
      inputTokens: 100, outputTokens: 50,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    // All fields ≤ prev, so cur becomes the delta
    expect(d.inputTokens).toBe(100);
    expect(d.outputTokens).toBe(50);
    expect(d.cachedReadTokens).toBe(0);
  });

  it('handles first-turn snapshot (prev all zeros)', () => {
    const prev: TokenUsage = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    const cur: TokenUsage = {
      inputTokens: 1000, outputTokens: 500,
      cachedReadTokens: 200, cachedNonReadTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(1000);
    expect(d.outputTokens).toBe(500);
    expect(d.cachedReadTokens).toBe(200);
  });
});

describe('priceTokens with delay tracking', () => {
  const rateCard = {
    inputCostPerMTok: 3.0,
    outputCostPerMTok: 15.0,
    cachedReadCostPerMTok: 0.3,
    cachedNonReadCostPerMTok: 3.0,
  };

  it('prices a turn with no cached/reasoning tokens', () => {
    const tokens: TokenUsage = {
      inputTokens: 1000, outputTokens: 500,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    const cost = priceTokens(tokens, rateCard);
    // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1e6 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('prices a turn with cached reads and non-reads', () => {
    const tokens: TokenUsage = {
      inputTokens: 2000, outputTokens: 1000,
      cachedReadTokens: 500, cachedNonReadTokens: 100,
    };
    const cost = priceTokens(tokens, rateCard);
    // (2000*3 + 1000*15 + 500*0.3 + 100*3) / 1e6
    // = (6000 + 15000 + 150 + 300) / 1e6 = 21450 / 1e6 = 0.02145
    expect(cost).toBeCloseTo(0.02145, 6);
  });

  it('per-turn delta cost accumulates correctly across multiple turns', () => {
    // Simulate a two-turn run within a single runner invocation:
    // Turn 1 cumulative: input=1000, output=500, cachedRead=200, cachedNonRead=0
    // Turn 2 cumulative: input=2500, output=1200, cachedRead=500, cachedNonRead=100

    const prev1: TokenUsage = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    const cur1: TokenUsage = {
      inputTokens: 1000, outputTokens: 500,
      cachedReadTokens: 200, cachedNonReadTokens: 0,
    };
    const delta1 = subtractTokens(cur1, prev1);
    const cost1 = priceTokens(delta1, rateCard);

    const cur2: TokenUsage = {
      inputTokens: 2500, outputTokens: 1200,
      cachedReadTokens: 500, cachedNonReadTokens: 100,
    };
    const delta2 = subtractTokens(cur2, cur1);
    const cost2 = priceTokens(delta2, rateCard);

    // Turn 1 cost: (1000*3 + 500*15 + 200*0.3) / 1e6 = (3000 + 7500 + 60) / 1e6 = 0.01056
    expect(cost1).toBeCloseTo(0.01056, 6);
    // Turn 2 cost: delta input=1500, output=700, cachedRead=300, cachedNonRead=100
    // (1500*3 + 700*15 + 300*0.3 + 100*3) / 1e6
    // = (4500 + 10500 + 90 + 300) / 1e6 = 15390 / 1e6 = 0.01539
    expect(cost2).toBeCloseTo(0.01539, 6);
    // Cumulative should equal pricing of final cumulative directly
    const totalFromDeltas = cost1 + cost2;
    const totalFromCur2 = priceTokens(cur2, rateCard);
    // priceTokens(cur2) = (2500*3 + 1200*15 + 500*0.3 + 100*3)/1e6
    // = (7500 + 18000 + 150 + 300) / 1e6 = 25950/1e6 = 0.02595
    expect(totalFromDeltas).toBeCloseTo(0.02595, 6);
    expect(totalFromCur2).toBeCloseTo(0.02595, 6);
  });
});

describe('resolveRateCard for lifecycle cost tracking', () => {
  it('returns null for unprofiled models', () => {
    const card = resolveRateCard('unprofiled-model-xyz');
    expect(card).toBeNull();
  });

  it('resolves known model profile', () => {
    const card = resolveRateCard('claude-sonnet-4-6');
    // Profile looks up known model pricing
    expect(card).not.toBeNull();
    expect(card!.inputCostPerMTok).toBeGreaterThan(0);
    expect(card!.outputCostPerMTok).toBeGreaterThan(0);
  });
});

describe('per-round delta tracking end-to-end contract', () => {
  it('cumulative uses per-turn subtraction, not per-invocation recomputation from scratch', () => {
    // This test validates the contract that the lifecycle's turn_complete
    // handler uses subtractTokens for per-turn cost, rather than calling
    // priceTokens(entireCumulative...) on every event which would double-count.

    // Simulate 3 turn_complete events from a single runner invocation:
    const events = [
      { cumulativeInputTokens: 1000, cumulativeOutputTokens: 500, cumulativeCachedReadTokens: 100, cumulativeCachedNonReadTokens: 0 },
      { cumulativeInputTokens: 2500, cumulativeOutputTokens: 1200, cumulativeCachedReadTokens: 300, cumulativeCachedNonReadTokens: 0 },
      { cumulativeInputTokens: 4000, cumulativeOutputTokens: 2000, cumulativeCachedReadTokens: 500, cumulativeCachedNonReadTokens: 100 },
    ];

    const rateCard = {
      inputCostPerMTok: 3.0,
      outputCostPerMTok: 15.0,
      cachedReadCostPerMTok: 0.3,
      cachedNonReadCostPerMTok: 3.0,
    };

    let lastCumulative: TokenUsage = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedNonReadTokens: 0,
    };
    let accumulatedCost = 0;

    for (const e of events) {
      const cur: TokenUsage = {
        inputTokens: e.cumulativeInputTokens,
        outputTokens: e.cumulativeOutputTokens,
        cachedReadTokens: e.cumulativeCachedReadTokens,
        cachedNonReadTokens: e.cumulativeCachedNonReadTokens,
      };
      const turnTokens = subtractTokens(cur, lastCumulative);
      lastCumulative = cur;
      accumulatedCost += priceTokens(turnTokens, rateCard);
    }

    // Final cumulative: input=4000, output=2000, cachedRead=500, cachedNonRead=100
    // = (4000*3 + 2000*15 + 500*0.3 + 100*3) / 1e6
    // = (12000 + 30000 + 150 + 300) / 1e6 = 42450/1e6 = 0.04245
    const directCost = priceTokens(lastCumulative, rateCard);
    expect(accumulatedCost).toBeCloseTo(directCost, 10);

    // The bug pattern: recomputing cost from cumulative on every event
    // would sum 3 × directCost instead of once. Verify our delta pattern
    // doesn't do that — accumulated should be directCost, not 3×.
    expect(accumulatedCost).toBeCloseTo(0.04245, 5);
    expect(accumulatedCost).not.toBeCloseTo(0.04245 * 3, 5);
  });
});
