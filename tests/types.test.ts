import { describe, it, expect } from 'vitest';
import { withTimeout, type RunResult } from '../src/types.js';

describe('withTimeout', () => {
  it('returns the promise result when it resolves before timeout', async () => {
    const result: RunResult = {
      output: 'done',
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01 },
      turns: 3,
      files: ['a.ts'],
    };
    const promise = Promise.resolve(result);

    const got = await withTimeout(promise, 5000, () => ({ files: [] }));
    expect(got).toEqual(result);
  });

  it('returns timeout result with partial progress when promise is slow', async () => {
    const neverResolves = new Promise<RunResult>(() => {});
    const ac = new AbortController();

    const got = await withTimeout(
      neverResolves,
      50,
      () => ({
        files: ['written.ts'],
        usage: { inputTokens: 100, outputTokens: 42, totalTokens: 142, costUSD: 0.05 },
        turns: 7,
      }),
      ac,
    );

    expect(got.status).toBe('timeout');
    expect(got.output).toBe('Agent timed out.');
    expect(got.files).toEqual(['written.ts']);
    expect(got.usage.inputTokens).toBe(100);
    expect(got.usage.outputTokens).toBe(42);
    expect(got.usage.totalTokens).toBe(142);
    expect(got.usage.costUSD).toBe(0.05);
    expect(got.turns).toBe(7);
    expect(ac.signal.aborted).toBe(true);
  });

  it('defaults to zero usage and turns when partial progress omits them', async () => {
    const neverResolves = new Promise<RunResult>(() => {});

    const got = await withTimeout(
      neverResolves,
      50,
      () => ({ files: ['f.ts'] }),
    );

    expect(got.status).toBe('timeout');
    expect(got.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null });
    expect(got.turns).toBe(0);
    expect(got.files).toEqual(['f.ts']);
  });
});
