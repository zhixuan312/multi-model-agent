import { describe, it, expect } from 'vitest';
import { subtractTokens, priceTokens } from '../../packages/core/src/bounded-execution/cost-compute.js';
import type { TokenUsage } from '../../packages/core/src/providers/runner-types.js';

describe('per-round delta tracking end-to-end contract', () => {
  it('cumulative uses per-turn subtraction, not per-invocation recomputation from scratch', () => {
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

    const directCost = priceTokens(lastCumulative, rateCard);
    expect(accumulatedCost).toBeCloseTo(directCost, 10);
    expect(accumulatedCost).toBeCloseTo(0.04245, 5);
    expect(accumulatedCost).not.toBeCloseTo(0.04245 * 3, 5);
  });
});
