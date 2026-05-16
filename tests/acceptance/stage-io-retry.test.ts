// tests/acceptance/stage-io-retry.test.ts
//
// Covers AC-19 and AC-20 from spec §11. Retry semantics for LLM-backed
// stages: transport failures trigger 3-attempt retry with 1s/2s backoff;
// non-transport caps trigger ZERO retries.

import { describe, it, expect } from 'vitest';
import { runAnnotatorTurn } from '../../packages/core/src/providers/run-annotator-turn.js';

function fakeCtx(sequence: Array<() => unknown>): {
  getSession: () => { send: (p: string) => Promise<unknown>; close: () => Promise<void> };
} {
  let i = 0;
  return {
    getSession: () => ({
      send: async () => {
        const fn = sequence[Math.min(i, sequence.length - 1)];
        i++;
        const out = fn();
        if (out instanceof Error) throw out;
        return out;
      },
      close: async () => {},
    }),
  };
}

describe('AC-19: LLM-backed handler retries transport failures exactly 3 attempts', () => {
  it('retries on network/5xx/timeout patterns and succeeds on retry', async () => {
    const ctx = fakeCtx([
      () => new Error('fetch failed: ECONNRESET'),
      () => new Error('transport error: 502'),
      () => ({ output: 'recovered', costUSD: 0, turns: 1 }),
    ]);
    const result = await runAnnotatorTurn({ prompt: 'p', ctx: ctx as any });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.text).toBe('recovered');
    }
  });

  it('returns transport_error after 3 failed transport attempts', async () => {
    const ctx = fakeCtx([
      () => new Error('5xx upstream'),
      () => new Error('5xx upstream'),
      () => new Error('5xx upstream'),
    ]);
    const result = await runAnnotatorTurn({ prompt: 'p', ctx: ctx as any });
    expect(result.kind).toBe('transport_error');
  }, 10000);
});

describe('AC-20: non-transport errors trigger ZERO retries', () => {
  it('breaks immediately on cost_cap-class errors (no retry sequence)', async () => {
    let callCount = 0;
    const ctx = {
      getSession: () => ({
        send: async () => {
          callCount++;
          throw new Error('cost_cap_exceeded');
        },
        close: async () => {},
      }),
    };
    const result = await runAnnotatorTurn({ prompt: 'p', ctx: ctx as any });
    expect(result.kind).toBe('transport_error');
    // The runAnnotatorTurn helper short-circuits on non-transport errors,
    // so only one call is made.
    expect(callCount).toBe(1);
  });

  it('breaks immediately on schema/validation-class errors (no retry sequence)', async () => {
    let callCount = 0;
    const ctx = {
      getSession: () => ({
        send: async () => {
          callCount++;
          throw new Error('brief_schema_invalid');
        },
        close: async () => {},
      }),
    };
    const result = await runAnnotatorTurn({ prompt: 'p', ctx: ctx as any });
    expect(result.kind).toBe('transport_error');
    expect(callCount).toBe(1);
  });
});
