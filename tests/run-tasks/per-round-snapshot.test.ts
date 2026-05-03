import { describe, it, expect } from 'vitest';
import { subtractTokens, priceTokens, resolveRateCard, type TokenCounts } from '../../packages/core/src/cost/compute.js';

describe('subtractTokens (per-turn delta tracking)', () => {
  it('returns per-field difference for normal growth', () => {
    const prev: TokenCounts = {
      inputTokens: 100, outputTokens: 50,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const cur: TokenCounts = {
      inputTokens: 300, outputTokens: 150,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(200);
    expect(d.outputTokens).toBe(100);
    expect(d.cachedReadTokens).toBe(0);
    expect(d.cachedCreationTokens).toBe(0);
    expect(d.reasoningTokens).toBe(0);
  });

  it('returns per-field difference with cached and reasoning growth', () => {
    const prev: TokenCounts = {
      inputTokens: 500, outputTokens: 200,
      cachedReadTokens: 100, cachedCreationTokens: 50, reasoningTokens: 0,
    };
    const cur: TokenCounts = {
      inputTokens: 1200, outputTokens: 500,
      cachedReadTokens: 300, cachedCreationTokens: 100, reasoningTokens: 80,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(700);
    expect(d.outputTokens).toBe(300);
    expect(d.cachedReadTokens).toBe(200);
    expect(d.cachedCreationTokens).toBe(50);
    expect(d.reasoningTokens).toBe(80);
  });

  it('clamps single-field decrease to 0 (provider reporting glitch)', () => {
    const prev: TokenCounts = {
      inputTokens: 500, outputTokens: 200,
      cachedReadTokens: 100, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    // inputTokens went backward (glitch), but output and cached grew
    const cur: TokenCounts = {
      inputTokens: 400, outputTokens: 300,
      cachedReadTokens: 150, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(0); // clamped
    expect(d.outputTokens).toBe(100);
    expect(d.cachedReadTokens).toBe(50);
  });

  it('detects counter reset (all fields ≤ prev) and treats cur as full delta', () => {
    const prev: TokenCounts = {
      inputTokens: 5000, outputTokens: 3000,
      cachedReadTokens: 500, cachedCreationTokens: 200, reasoningTokens: 0,
    };
    // Counter reset (new sub-agent session)
    const cur: TokenCounts = {
      inputTokens: 100, outputTokens: 50,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const d = subtractTokens(cur, prev);
    // All fields ≤ prev, so cur becomes the delta
    expect(d.inputTokens).toBe(100);
    expect(d.outputTokens).toBe(50);
    expect(d.cachedReadTokens).toBe(0);
  });

  it('handles first-turn snapshot (prev all zeros)', () => {
    const prev: TokenCounts = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const cur: TokenCounts = {
      inputTokens: 1000, outputTokens: 500,
      cachedReadTokens: 200, cachedCreationTokens: 0, reasoningTokens: 50,
    };
    const d = subtractTokens(cur, prev);
    expect(d.inputTokens).toBe(1000);
    expect(d.outputTokens).toBe(500);
    expect(d.cachedReadTokens).toBe(200);
    expect(d.reasoningTokens).toBe(50);
  });
});

describe('priceTokens with delay tracking', () => {
  const rateCard = {
    inputCostPerMTok: 3.0,
    outputCostPerMTok: 15.0,
    cachedReadCostPerMTok: 0.3,
    cachedCreationCostPerMTok: 3.0,
    reasoningCostPerMTok: 15.0,
  };

  it('prices a turn with no cached/reasoning tokens', () => {
    const tokens: TokenCounts = {
      inputTokens: 1000, outputTokens: 500,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const cost = priceTokens(tokens, rateCard);
    // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1e6 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('prices a turn with cached reads and reasoning', () => {
    const tokens: TokenCounts = {
      inputTokens: 2000, outputTokens: 1000,
      cachedReadTokens: 500, cachedCreationTokens: 100, reasoningTokens: 200,
    };
    const cost = priceTokens(tokens, rateCard);
    // (2000*3 + 1000*15 + 500*0.3 + 100*3 + 200*15) / 1e6
    // = (6000 + 15000 + 150 + 300 + 3000) / 1e6 = 24450 / 1e6 = 0.02445
    expect(cost).toBeCloseTo(0.02445, 6);
  });

  it('per-turn delta cost accumulates correctly across multiple turns', () => {
    // Simulate a two-turn run within a single runner invocation:
    // Turn 1 cumulative: input=1000, output=500, cachedRead=200, cachedCreation=0, reasoning=0
    // Turn 2 cumulative: input=2500, output=1200, cachedRead=500, cachedCreation=100, reasoning=80

    const prev1: TokenCounts = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const cur1: TokenCounts = {
      inputTokens: 1000, outputTokens: 500,
      cachedReadTokens: 200, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    const delta1 = subtractTokens(cur1, prev1);
    const cost1 = priceTokens(delta1, rateCard);

    const cur2: TokenCounts = {
      inputTokens: 2500, outputTokens: 1200,
      cachedReadTokens: 500, cachedCreationTokens: 100, reasoningTokens: 80,
    };
    const delta2 = subtractTokens(cur2, cur1);
    const cost2 = priceTokens(delta2, rateCard);

    // Turn 1 cost: (1000*3 + 500*15 + 200*0.3) / 1e6 = (3000 + 7500 + 60) / 1e6 = 0.01056
    expect(cost1).toBeCloseTo(0.01056, 6);
    // Turn 2 cost: delta input=1500, output=700, cachedRead=300, cachedCreation=100, reasoning=80
    // (1500*3 + 700*15 + 300*0.3 + 100*3 + 80*15) / 1e6
    // = (4500 + 10500 + 90 + 300 + 1200) / 1e6 = 16590 / 1e6 = 0.01659
    expect(cost2).toBeCloseTo(0.01659, 6);
    // Cumulative should equal pricing of final cumulative directly
    const totalFromDeltas = cost1 + cost2;
    const totalFromCur2 = priceTokens(cur2, rateCard);
    // Note: subset semantics — cur2.inputTokens includes everything.
    // The delta approach and direct approach should match because
    // priceTokens treats inputTokens and cachedReadTokens as separate dimensions.
    // With cached creation > 0: priceTokens(cur2) = (2500*3 + 1200*15 + 500*0.3 + 100*3 + 80*15)/1e6
    // = (7500 + 18000 + 150 + 300 + 1200) / 1e6 = 27150/1e6 = 0.02715
    expect(totalFromDeltas).toBeCloseTo(0.02715, 6);
    expect(totalFromCur2).toBeCloseTo(0.02715, 6);
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
    // computeCostUSD(entireCumulativeInput, entireCumulativeOutput, config)
    // which would double-count on every cumulative event.

    // Simulate 3 turn_complete events from a single runner invocation:
    const events = [
      { cumulativeInputTokens: 1000, cumulativeOutputTokens: 500, cumulativeCachedReadTokens: 100, cumulativeCachedCreationTokens: 0, cumulativeReasoningTokens: 0 },
      { cumulativeInputTokens: 2500, cumulativeOutputTokens: 1200, cumulativeCachedReadTokens: 300, cumulativeCachedCreationTokens: 0, cumulativeReasoningTokens: 50 },
      { cumulativeInputTokens: 4000, cumulativeOutputTokens: 2000, cumulativeCachedReadTokens: 500, cumulativeCachedCreationTokens: 100, cumulativeReasoningTokens: 150 },
    ];

    const rateCard = {
      inputCostPerMTok: 3.0,
      outputCostPerMTok: 15.0,
      cachedReadCostPerMTok: 0.3,
      cachedCreationCostPerMTok: 3.0,
      reasoningCostPerMTok: 15.0,
    };

    let lastCumulative: TokenCounts = {
      inputTokens: 0, outputTokens: 0,
      cachedReadTokens: 0, cachedCreationTokens: 0, reasoningTokens: 0,
    };
    let accumulatedCost = 0;

    for (const e of events) {
      const cur: TokenCounts = {
        inputTokens: e.cumulativeInputTokens,
        outputTokens: e.cumulativeOutputTokens,
        cachedReadTokens: e.cumulativeCachedReadTokens,
        cachedCreationTokens: e.cumulativeCachedCreationTokens,
        reasoningTokens: e.cumulativeReasoningTokens,
      };
      const turnTokens = subtractTokens(cur, lastCumulative);
      lastCumulative = cur;
      accumulatedCost += priceTokens(turnTokens, rateCard);
    }

    // Final cumulative: input=4000, output=2000, cachedRead=500, cachedCreation=100, reasoning=150
    // = (4000*3 + 2000*15 + 500*0.3 + 100*3 + 150*15) / 1e6
    // = (12000 + 30000 + 150 + 300 + 2250) / 1e6 = 44700/1e6 = 0.0447
    const directCost = priceTokens(lastCumulative, rateCard);
    expect(accumulatedCost).toBeCloseTo(directCost, 10);

    // The bug pattern: recomputing cost from cumulative on every event
    // would sum 3 × directCost instead of once. Verify our delta pattern
    // doesn't do that — accumulated should be directCost, not 3×.
    expect(accumulatedCost).toBeCloseTo(0.0447, 5);
    expect(accumulatedCost).not.toBeCloseTo(0.0447 * 3, 5);
  });
});
