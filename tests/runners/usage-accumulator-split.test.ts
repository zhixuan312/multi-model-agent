import { describe, it, expect } from 'vitest';
import { mergeUsage, makeEmptyUsage } from '../../packages/core/src/runners/base/usage-accumulator.js';

describe('CanonicalUsage split cache fields', () => {
  it('mergeUsage accumulates cachedReadTokens and cachedCreationTokens independently', () => {
    let acc = makeEmptyUsage();
    acc = mergeUsage(acc, {
      inputTokens: 100, outputTokens: 50,
      cachedReadTokens: 40, cachedCreationTokens: 20,
      reasoningTokens: null,
    });
    acc = mergeUsage(acc, {
      inputTokens: 200, outputTokens: 100,
      cachedReadTokens: 30, cachedCreationTokens: 0,
      reasoningTokens: null,
    });
    expect(acc.cachedReadTokens).toBe(70);
    expect(acc.cachedCreationTokens).toBe(20);
  });

  it('null cachedReadTokens stays null until first non-null contribution', () => {
    let acc = makeEmptyUsage();
    expect(acc.cachedReadTokens).toBeNull();
    acc = mergeUsage(acc, {
      inputTokens: 10, outputTokens: 5,
      cachedReadTokens: null, cachedCreationTokens: null,
      reasoningTokens: null,
    });
    expect(acc.cachedReadTokens).toBeNull();
    acc = mergeUsage(acc, {
      inputTokens: 10, outputTokens: 5,
      cachedReadTokens: 5, cachedCreationTokens: 0,
      reasoningTokens: null,
    });
    expect(acc.cachedReadTokens).toBe(5);
  });
});
