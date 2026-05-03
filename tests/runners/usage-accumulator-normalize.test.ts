import { describe, it, expect } from 'vitest';
import { normalizeUsageToSubset } from '../../packages/core/src/runners/base/usage-accumulator.js';

describe('Item 10: usage normalizer enforces subset semantics', () => {
  it('lifts inputTokens when cachedTokens > inputTokens (sibling input)', () => {
    const u = { inputTokens: 100, outputTokens: 50, cachedTokens: 800, reasoningTokens: 0 };
    const n = normalizeUsageToSubset(u);
    expect(n.inputTokens).toBe(900);
    expect(n.cachedTokens).toBe(800);
    expect(n.cachedTokens).toBeLessThanOrEqual(n.inputTokens);
  });

  it('passes through unchanged when cached <= input', () => {
    const u = { inputTokens: 1000, outputTokens: 100, cachedTokens: 200, reasoningTokens: 0 };
    const n = normalizeUsageToSubset(u);
    expect(n.inputTokens).toBe(1000);
  });

  it('handles cachedTokens null gracefully', () => {
    const u = { inputTokens: 500, outputTokens: 100, cachedTokens: null, reasoningTokens: 0 };
    const n = normalizeUsageToSubset(u);
    expect(n.inputTokens).toBe(500);
    expect(n.cachedTokens).toBeNull();
  });
});
