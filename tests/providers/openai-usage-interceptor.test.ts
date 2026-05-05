// 3.12.4 regression: HTTP-level usage interceptor for openai-compatible
// providers must capture usage from BOTH non-streaming and streaming
// responses, including the case where intermediate stream chunks have
// `usage:undefined` (DeepSeek behavior that wipes the SDK's per-chunk
// aggregation). The runner falls back to this accumulator when
// `currentResult.state.usage.inputTokens === 0` despite turns having occurred.

import { describe, it, expect } from 'vitest';
import { wrapClientForUsageCapture } from '../../packages/core/src/providers/openai-usage-interceptor.js';

describe('openai-usage-interceptor', () => {
  it('captures usage from a non-streaming Chat Completion response', async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async (_args: unknown) => ({
            id: 'chatcmpl-1',
            choices: [{ message: { role: 'assistant', content: 'hi' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: 10 },
            },
          }),
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulator = wrapClientForUsageCapture(fakeClient as any);
    expect(accumulator.hasObservedUsage()).toBe(false);

    await fakeClient.chat.completions.create({});

    expect(accumulator.hasObservedUsage()).toBe(true);
    const snap = accumulator.snapshot();
    expect(snap.promptTokens).toBe(100);
    expect(snap.completionTokens).toBe(50);
    expect(snap.cachedReadTokens).toBe(10);
    expect(snap.responses).toBe(1);
  });

  it('captures usage from a streaming response and is robust to mid-stream usage:undefined chunks (DeepSeek case)', async () => {
    // Mimic DeepSeek's pathological stream: usage appears on an early
    // chunk, then later chunks have usage:undefined. The @openai/agents SDK
    // overwrites its captured usage to undefined and ends with zeros.
    // Our interceptor takes the LAST seen non-null usage (cumulative
    // semantics), so the final state is the real number.
    const chunks: Array<{ choices?: unknown[]; usage?: unknown }> = [
      { choices: [{ delta: { content: 'one ' } }] },
      { choices: [{ delta: { content: 'two ' } }], usage: { prompt_tokens: 200, completion_tokens: 80 } },
      { choices: [{ delta: { content: 'three' } }] },                  // usage absent
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: undefined }, // usage explicitly undefined
    ];
    const fakeClient = {
      chat: {
        completions: {
          create: async (_args: unknown) => ({
            // AsyncIterable with no `choices` property → interceptor takes streaming branch
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c;
            },
          }),
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulator = wrapClientForUsageCapture(fakeClient as any);

    const stream = await fakeClient.chat.completions.create({});
    // Drain the stream as the SDK would — the wrapper observes each chunk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const _chunk of stream as any) {
      // no-op: just consuming the wrapped iterator
    }

    expect(accumulator.hasObservedUsage()).toBe(true);
    const snap = accumulator.snapshot();
    expect(snap.promptTokens).toBe(200);
    expect(snap.completionTokens).toBe(80);
    expect(snap.responses).toBe(1);
  });

  it('accumulates across multiple calls (multi-turn agent loop)', async () => {
    let callIndex = 0;
    const fakeClient = {
      chat: {
        completions: {
          create: async (_args: unknown) => {
            callIndex++;
            return {
              id: `chatcmpl-${callIndex}`,
              choices: [{ message: { role: 'assistant', content: 'x' } }],
              usage: { prompt_tokens: 100 * callIndex, completion_tokens: 30 * callIndex },
            };
          },
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulator = wrapClientForUsageCapture(fakeClient as any);

    await fakeClient.chat.completions.create({});
    await fakeClient.chat.completions.create({});
    await fakeClient.chat.completions.create({});

    const snap = accumulator.snapshot();
    expect(snap.promptTokens).toBe(100 + 200 + 300);
    expect(snap.completionTokens).toBe(30 + 60 + 90);
    expect(snap.responses).toBe(3);
  });

  it('hasObservedUsage stays false when responses have usage but tokens are zero (e.g. immediate refusal)', async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async (_args: unknown) => ({
            id: 'chatcmpl-refusal',
            choices: [{ message: { role: 'assistant', content: '', refusal: 'I cannot help with that.' } }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulator = wrapClientForUsageCapture(fakeClient as any);
    await fakeClient.chat.completions.create({});

    // Counted as a response (responses=1), but no real tokens — the runner
    // uses hasObservedUsage to decide whether to trust this fallback over
    // SDK state.usage. A zero-token response shouldn't convince the runner
    // to override SDK state with zeros.
    expect(accumulator.hasObservedUsage()).toBe(false);
    expect(accumulator.snapshot().responses).toBe(1);
  });
});
