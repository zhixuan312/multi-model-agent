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

  // ── Zero vs null semantics ───────────────────────────────────────────

  it('zero is a real observed value, distinct from null', () => {
    const u = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0 });
    expect(u.cachedTokens).toBe(0);
    expect(u.reasoningTokens).toBe(0);
  });

  it('null + null stays null even after multiple turns', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: null, reasoningTokens: null });
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: null, reasoningTokens: null });
    expect(u.cachedTokens).toBeNull();
    expect(u.reasoningTokens).toBeNull();
  });

  it('zero + zero accumulates to zero', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0 });
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0 });
    expect(u.cachedTokens).toBe(0);
    expect(u.reasoningTokens).toBe(0);
  });

  // ── Mixed null/non-null turns ─────────────────────────────────────────

  it('number + null after a prior real value preserves the accumulated number', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 5 });
    // Next turn doesn't expose cached/reasoning (null) — should preserve accumulated values
    u = mergeUsage(u, { inputTokens: 50, outputTokens: 25, cachedTokens: null, reasoningTokens: null });
    expect(u.cachedTokens).toBe(10);
    expect(u.reasoningTokens).toBe(5);
  });

  it('mixed turns accumulate correctly: null then number then null', () => {
    let u = makeEmptyUsage();
    // Turn 1: no cached/reasoning exposure
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: null, reasoningTokens: null });
    expect(u.cachedTokens).toBeNull();
    // Turn 2: provider exposes cached/reasoning
    u = mergeUsage(u, { inputTokens: 200, outputTokens: 100, cachedTokens: 15, reasoningTokens: 8 });
    expect(u.cachedTokens).toBe(15);
    expect(u.reasoningTokens).toBe(8);
    // Turn 3: provider doesn't expose again
    u = mergeUsage(u, { inputTokens: 50, outputTokens: 25, cachedTokens: null, reasoningTokens: null });
    expect(u.cachedTokens).toBe(15);
    expect(u.reasoningTokens).toBe(8);
  });

  it('input and output tokens accumulate independently of null gap fields', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedTokens: null, reasoningTokens: null });
    u = mergeUsage(u, { inputTokens: 200, outputTokens: 100, cachedTokens: 10, reasoningTokens: null });
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(150);
    expect(u.cachedTokens).toBe(10);
    expect(u.reasoningTokens).toBeNull();
  });

  // ── Immutability ──────────────────────────────────────────────────────

  it('mergeUsage returns a new object', () => {
    const acc = makeEmptyUsage();
    const result = mergeUsage(acc, { inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 5 });
    expect(result).not.toBe(acc);
  });

  it('mergeUsage does not mutate the accumulator', () => {
    const acc = makeEmptyUsage();
    mergeUsage(acc, { inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 5 });
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
    expect(acc.cachedTokens).toBeNull();
    expect(acc.reasoningTokens).toBeNull();
  });

  it('makeEmptyUsage returns a new object each call', () => {
    const a = makeEmptyUsage();
    const b = makeEmptyUsage();
    expect(a).not.toBe(b);
    a.inputTokens = 42;
    expect(b.inputTokens).toBe(0);
  });

  // ── Large number accumulation ─────────────────────────────────────────

  it('handles large token counts', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 100_000, reasoningTokens: 50_000 });
    u = mergeUsage(u, { inputTokens: 2_000_000, outputTokens: 1_000_000, cachedTokens: 200_000, reasoningTokens: 100_000 });
    expect(u.inputTokens).toBe(3_000_000);
    expect(u.outputTokens).toBe(1_500_000);
    expect(u.cachedTokens).toBe(300_000);
    expect(u.reasoningTokens).toBe(150_000);
  });
});
