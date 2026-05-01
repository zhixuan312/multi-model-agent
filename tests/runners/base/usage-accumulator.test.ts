import { describe, it, expect } from 'vitest';
import { CanonicalUsage, mergeUsage, makeEmptyUsage } from '../../../packages/core/src/runners/base/usage-accumulator.js';

describe('CanonicalUsage', () => {
  it('empty accumulator has zero numbers and null gap fields', () => {
    const u = makeEmptyUsage();
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
    expect(u.cachedTokens).toBeNull();
    expect(u.reasoningTokens).toBeNull();
  });

  it('mergeUsage promotes null + number to number (treats null as 0 ONLY for accumulation, not for absence-signaling)', () => {
    const u = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: null });
    expect(u.cachedTokens).toBe(10);
    expect(u.reasoningTokens).toBeNull();
  });

  it('mergeUsage with all-null source preserves null', () => {
    const u = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedTokens: null, reasoningTokens: null });
    expect(u.cachedTokens).toBeNull();
    expect(u.reasoningTokens).toBeNull();
  });

  it('mergeUsage accumulates numbers across multiple turns', () => {
    const a = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 5 });
    const b = mergeUsage(a, { inputTokens: 200, outputTokens: 100, cachedTokens: 20, reasoningTokens: 10 });
    expect(b.inputTokens).toBe(300);
    expect(b.outputTokens).toBe(150);
    expect(b.cachedTokens).toBe(30);
    expect(b.reasoningTokens).toBe(15);
  });

  it('mergeUsage switches from null to number once a real value appears', () => {
    const a = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedTokens: null, reasoningTokens: null });
    expect(a.cachedTokens).toBeNull();
    expect(a.reasoningTokens).toBeNull();
    const b = mergeUsage(a, { inputTokens: 50, outputTokens: 25, cachedTokens: 5, reasoningTokens: 2 });
    expect(b.cachedTokens).toBe(5);
    expect(b.reasoningTokens).toBe(2);
  });
});
