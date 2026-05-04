// HTTP-level usage capture for openai-compatible providers, independent of
// @openai/agents' internal aggregation.
//
// Why this exists: the @openai/agents SDK's stream consumer
// (node_modules/@openai/agents-openai/dist/openaiChatCompletionsStreaming.js
// line ~38) overwrites its local `usage` variable on every SSE chunk:
//
//     usage = chunk.usage || undefined;
//
// For OpenAI proper this is benign — only the final `[DONE]`-adjacent chunk
// carries usage, so the last write is the right one. For DeepSeek (and
// likely other openai-compatible providers) with multi-turn tool-use, later
// chunks can have `usage:undefined` AFTER an earlier chunk reported real
// numbers, wiping the captured usage. The SDK then ends with
// `state.usage.inputTokens=0`, costUSD=0, despite real tokens having
// flowed. mma 3.12.2 telemetry showed every DeepSeek-as-reviewer call
// logging 21+ turns and zero tokens, untraceable until the SDK source was
// inspected.
//
// Fix: wrap the OpenAI client's `chat.completions.create` so we see the
// raw HTTP response (or the raw SSE stream) BEFORE the SDK consumes it, and
// accumulate usage into an out-of-band counter the runner can read at
// result-time as a source-of-truth fallback. The wrapper does not modify
// SDK-visible behavior — it observes only.

import type OpenAI from 'openai';

export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  /** Number of completed HTTP responses observed (one per SDK turn). */
  responses: number;
}

export interface UsageAccumulator {
  /** Latest cumulative usage from the wrapped client. Returns a fresh snapshot. */
  snapshot(): UsageSnapshot;
  /** True if at least one response observed real (non-zero) usage. Used by
   *  the runner to decide whether to trust SDK state.usage or fall back here. */
  hasObservedUsage(): boolean;
}

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function addUsage(acc: UsageSnapshot, u: UsageLike): UsageSnapshot {
  return {
    promptTokens: acc.promptTokens + (u.prompt_tokens ?? 0),
    completionTokens: acc.completionTokens + (u.completion_tokens ?? 0),
    cachedReadTokens: acc.cachedReadTokens + (u.prompt_tokens_details?.cached_tokens ?? 0),
    reasoningTokens: acc.reasoningTokens + (u.completion_tokens_details?.reasoning_tokens ?? 0),
    responses: acc.responses + 1,
  };
}

/** Wrap an OpenAI client so usage from every chat.completions.create response
 *  is captured into the returned UsageAccumulator.
 *
 *  Mutates `client.chat.completions.create` in place. The wrapped client is
 *  otherwise unchanged — same return shapes, same error behavior. The SDK
 *  sees the same response stream byte-for-byte (we tee, we don't transform).
 */
export function wrapClientForUsageCapture(client: OpenAI): UsageAccumulator {
  let acc: UsageSnapshot = {
    promptTokens: 0,
    completionTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    responses: 0,
  };
  let observedNonZero = false;

  const observe = (u: UsageLike | null | undefined): void => {
    if (!u) return;
    const before = acc;
    acc = addUsage(acc, u);
    // hasObservedUsage flips true the first time a response carries real
    // input or output tokens. Counters can stay at 0 for empty responses
    // (auth failures, immediate refusals) — those don't count as evidence
    // that the provider IS reporting usage.
    if ((u.prompt_tokens ?? 0) > 0 || (u.completion_tokens ?? 0) > 0) {
      observedNonZero = true;
    }
    void before;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completions = client.chat.completions as any;
  const originalCreate = completions.create.bind(completions);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completions.create = async function wrappedCreate(...args: any[]): Promise<any> {
    const result = await originalCreate(...args);

    // Non-streaming branch: result is a ChatCompletion object with usage.
    // Detect via the presence of `choices` (eagerly resolved) and `usage`.
    if (result && typeof result === 'object' && Array.isArray(result.choices)) {
      observe(result.usage);
      return result;
    }

    // Streaming branch: result is an AsyncIterable of chunks. We wrap the
    // iterator so each yielded chunk's usage feeds the accumulator without
    // changing what the SDK sees.
    if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      const inner = result as AsyncIterable<{ usage?: UsageLike | null }>;
      // Build a thin wrapper that preserves the original async-iterable
      // identity (so the SDK can still .controller-abort if it does), but
      // observes usage on every chunk that has it. Note: we accumulate the
      // FIRST non-null usage we see from each request (chunks-with-usage are
      // typically only 1 per stream, sent on the [DONE] frame). If a
      // provider sends multiple usage frames, we add each one — that matches
      // the cumulative semantics.
      const wrapped: AsyncIterable<unknown> & { controller?: unknown } = {
        async *[Symbol.asyncIterator]() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let lastUsage: UsageLike | null | undefined;
          for await (const chunk of inner) {
            if (chunk && chunk.usage) {
              lastUsage = chunk.usage;
            }
            yield chunk;
          }
          // Accumulate at end-of-stream so multiple intra-stream `usage`
          // chunks (DeepSeek behavior) don't double-count. The last seen
          // usage is the cumulative-for-this-request value the provider
          // wanted us to see.
          observe(lastUsage);
        },
      };
      // Some SDK call sites poke at `.controller` on the stream object for
      // abort handling. Forward it if present.
      const ctrl = (result as { controller?: unknown }).controller;
      if (ctrl !== undefined) wrapped.controller = ctrl;
      return wrapped;
    }

    // Unknown shape (shouldn't happen for chat.completions.create) — pass
    // through unmodified.
    return result;
  };

  return {
    snapshot: () => ({ ...acc }),
    hasObservedUsage: () => observedNonZero,
  };
}
