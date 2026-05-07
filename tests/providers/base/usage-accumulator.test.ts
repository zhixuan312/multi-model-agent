import { describe, it, expect } from 'vitest';
import { mergeUsage, makeEmptyUsage } from '../../../packages/core/src/providers/base/usage-accumulator.js';
import type { CanonicalUsage } from '../../../packages/core/src/providers/base/usage-accumulator.js';

describe('CanonicalUsage', () => {
  it('empty accumulator has zero numbers and null gap fields', () => {
    const u = makeEmptyUsage();
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
    expect(u.cachedReadTokens).toBeNull();
    expect(u.cachedNonReadTokens).toBeNull();
  });

  it('mergeUsage promotes null + number to number (treats null as 0 ONLY for accumulation, not for absence-signaling)', () => {
    const u = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 0 });
    expect(u.cachedReadTokens).toBe(10);
    expect(u.cachedNonReadTokens).toBe(0);
  });

  it('mergeUsage with all-null source preserves null', () => {
    const u = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cachedNonReadTokens: null });
    expect(u.cachedReadTokens).toBeNull();
    expect(u.cachedNonReadTokens).toBeNull();
  });

  it('mergeUsage accumulates numbers across multiple turns', () => {
    const a = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 0 });
    const b = mergeUsage(a, { inputTokens: 200, outputTokens: 100, cachedReadTokens: 20, cachedNonReadTokens: 0 });
    expect(b.inputTokens).toBe(300);
    expect(b.outputTokens).toBe(150);
    expect(b.cachedReadTokens).toBe(30);
    expect(b.cachedNonReadTokens).toBe(0);
  });

  it('mergeUsage switches from null to number once a real value appears', () => {
    const a = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cachedNonReadTokens: null });
    expect(a.cachedReadTokens).toBeNull();
    expect(a.cachedNonReadTokens).toBeNull();
    const b = mergeUsage(a, { inputTokens: 50, outputTokens: 25, cachedReadTokens: 5, cachedNonReadTokens: 0 });
    expect(b.cachedReadTokens).toBe(5);
    expect(b.cachedNonReadTokens).toBe(0);
  });

  // ── Zero vs null semantics ───────────────────────────────────────────

  it('zero is a real observed value, distinct from null', () => {
    const u = mergeUsage(makeEmptyUsage(), { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 });
    expect(u.cachedReadTokens).toBe(0);
    expect(u.cachedNonReadTokens).toBe(0);
  });

  it('null + null stays null even after multiple turns', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cachedNonReadTokens: null });
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cachedNonReadTokens: null });
    expect(u.cachedReadTokens).toBeNull();
    expect(u.cachedNonReadTokens).toBeNull();
  });

  it('zero + zero accumulates to zero', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 });
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 });
    expect(u.cachedReadTokens).toBe(0);
    expect(u.cachedNonReadTokens).toBe(0);
  });

  // ── Mixed null/non-null turns ─────────────────────────────────────────

  it('number + null after a prior real value preserves the accumulated number', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 0 });
    u = mergeUsage(u, { inputTokens: 50, outputTokens: 25, cachedReadTokens: null, cachedNonReadTokens: null });
    expect(u.cachedReadTokens).toBe(10);
    expect(u.cachedNonReadTokens).toBe(0);
  });

  it('mixed turns accumulate correctly: null then number then null', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cachedNonReadTokens: null });
    expect(u.cachedReadTokens).toBeNull();
    expect(u.cachedNonReadTokens).toBeNull();
    u = mergeUsage(u, { inputTokens: 200, outputTokens: 100, cachedReadTokens: 15, cachedNonReadTokens: 0 });
    expect(u.cachedReadTokens).toBe(15);
    expect(u.cachedNonReadTokens).toBe(0);
    u = mergeUsage(u, { inputTokens: 50, outputTokens: 25, cachedReadTokens: null, cachedNonReadTokens: null });
    expect(u.cachedReadTokens).toBe(15);
    expect(u.cachedNonReadTokens).toBe(0);
  });

  it('input and output tokens accumulate independently of null gap fields', () => {
    let u = makeEmptyUsage();
    u = mergeUsage(u, { inputTokens: 100, outputTokens: 50, cachedReadTokens: null, cachedNonReadTokens: null });
    u = mergeUsage(u, { inputTokens: 200, outputTokens: 100, cachedReadTokens: 10, cachedNonReadTokens: 0 });
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(150);
    expect(u.cachedReadTokens).toBe(10);
    expect(u.cachedNonReadTokens).toBe(0);
  });

  // ── Immutability ──────────────────────────────────────────────────────

  it('mergeUsage returns a new object', () => {
    const acc = makeEmptyUsage();
    const result = mergeUsage(acc, { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 0 });
    expect(result).not.toBe(acc);
  });

  it('mergeUsage does not mutate the accumulator', () => {
    const acc = makeEmptyUsage();
    mergeUsage(acc, { inputTokens: 100, outputTokens: 50, cachedReadTokens: 10, cachedNonReadTokens: 0 });
    expect(acc.inputTokens).toBe(0);
    expect(acc.outputTokens).toBe(0);
    expect(acc.cachedReadTokens).toBeNull();
    expect(acc.cachedNonReadTokens).toBeNull();
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
    u = mergeUsage(u, { inputTokens: 1_000_000, outputTokens: 500_000, cachedReadTokens: 100_000, cachedNonReadTokens: 0 });
    u = mergeUsage(u, { inputTokens: 2_000_000, outputTokens: 1_000_000, cachedReadTokens: 200_000, cachedNonReadTokens: 0 });
    expect(u.inputTokens).toBe(3_000_000);
    expect(u.outputTokens).toBe(1_500_000);
    expect(u.cachedReadTokens).toBe(300_000);
    expect(u.cachedNonReadTokens).toBe(0);
  });
});
