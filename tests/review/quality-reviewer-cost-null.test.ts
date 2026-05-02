import { describe, it, expect } from 'vitest';
import { extractMetrics } from '../../packages/core/src/review/quality-reviewer.js';

describe('Item 7: extractMetrics propagates null cost', () => {
  it('returns null cost when usage.costUSD is null', () => {
    const fakeResult: any = { usage: { inputTokens: 100, outputTokens: 50, costUSD: null }, turns: 3, toolCalls: [] };
    const m = extractMetrics(fakeResult);
    expect(m.costUSD).toBeNull();
  });

  it('returns null cost when usage is undefined', () => {
    const fakeResult: any = { usage: undefined, turns: 0, toolCalls: [] };
    const m = extractMetrics(fakeResult);
    expect(m.costUSD).toBeNull();
  });

  it('returns 0 cost when usage.costUSD is explicitly 0 (free, not unknown)', () => {
    const fakeResult: any = { usage: { inputTokens: 100, outputTokens: 50, costUSD: 0 }, turns: 1, toolCalls: [] };
    const m = extractMetrics(fakeResult);
    expect(m.costUSD).toBe(0);
  });

  it('returns the actual cost when usage.costUSD is a number', () => {
    const fakeResult: any = { usage: { inputTokens: 100, outputTokens: 50, costUSD: 0.0123 }, turns: 1, toolCalls: [] };
    const m = extractMetrics(fakeResult);
    expect(m.costUSD).toBe(0.0123);
  });
});
