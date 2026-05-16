// tests/providers/codex-cli-session.test.ts
//
// Pins the cross-provider TokenUsage contract for the codex adapter.
//
// Background: OpenAI's Responses API / codex CLI emits `input_tokens` as
// GROSS (it INCLUDES `cached_input_tokens` as a subset — confirmed by
// codex's Rust protocol source: `non_cached_input = input_tokens -
// cached_input()`). Anthropic's API emits the same field as NET (post-
// cache-breakpoint only, disjoint from cache fields).
//
// Our shared `TokenUsage` shape uses Anthropic's disjoint partition. The
// codex adapter MUST subtract cached out of gross before storing
// inputTokens; otherwise priceTokens (which treats input + cachedRead as
// disjoint buckets) bills the cached portion twice — once at the full
// input rate and once at the cached-read rate. That's exactly the bug we
// shipped this fix to close. See
// `docs/superpowers/specs/...` for the full investigation.

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { __test } from '../../packages/core/src/providers/codex-cli-session.js';
import type { TokenUsage } from '../../packages/core/src/providers/runner-types.js';
import type { CodexCliEvent } from '../../packages/core/src/providers/codex-cli-event.js';

const { TurnTracker } = __test;

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
}

function turnCompletedEvent(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}): CodexCliEvent {
  return { kind: 'turn_completed', usage } as CodexCliEvent;
}

describe('codex TurnTracker — TokenUsage disjoint-partition contract', () => {
  it('subtracts cached_input_tokens from input_tokens before storing (gross → net)', () => {
    // Codex reports: input_tokens=1000 (GROSS, includes cached), cached=700.
    // After normalization: stored inputTokens=300 (NET), cachedReadTokens=700.
    // The two are disjoint and sum back to 1000 — the model's actual prompt.
    const cumulative = zeroUsage();
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 1000,
      output_tokens: 50,
      cached_input_tokens: 700,
    }));
    const delta = tracker.flushUsageDelta();
    expect(delta.inputTokens).toBe(300);
    expect(delta.outputTokens).toBe(50);
    expect(delta.cachedReadTokens).toBe(700);
    expect(delta.cachedNonReadTokens).toBe(0);
  });

  it('clamps negative net-input to zero when cached exceeds gross (provider-glitch guard)', () => {
    // Defensive: if codex ever reports cached > gross (shouldn't happen),
    // Math.max(0, gross-cached) prevents negative inputTokens.
    const cumulative = zeroUsage();
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 100,
      cached_input_tokens: 500,
    }));
    const delta = tracker.flushUsageDelta();
    expect(delta.inputTokens).toBe(0);
    expect(delta.cachedReadTokens).toBe(500);
  });

  it('handles a turn with no cached tokens (first turn, cold session)', () => {
    const cumulative = zeroUsage();
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 500,
      output_tokens: 25,
      // cached_input_tokens omitted — cold call
    }));
    const delta = tracker.flushUsageDelta();
    expect(delta.inputTokens).toBe(500);
    expect(delta.cachedReadTokens).toBe(0);
  });

  it('sums reasoning_output_tokens into outputTokens (codex protocol: disjoint, billed at output rate)', () => {
    const cumulative = zeroUsage();
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 100,
      output_tokens: 50,
      reasoning_output_tokens: 200,
    }));
    const delta = tracker.flushUsageDelta();
    expect(delta.outputTokens).toBe(250); // 50 + 200, both billed at output rate
  });

  it('accumulates across multiple turn_completed events within one tracker', () => {
    const cumulative = zeroUsage();
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100,
    }));
    tracker.consume(turnCompletedEvent({
      input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 80,
    }));
    const delta = tracker.flushUsageDelta();
    // Net input: (1000-600) + (1500-1200) = 400 + 300 = 700
    expect(delta.inputTokens).toBe(700);
    expect(delta.cachedReadTokens).toBe(1800);
    expect(delta.outputTokens).toBe(180);
  });

  it('flushUsageDelta returns delta relative to snapshot (subprocess-boundary safe)', () => {
    // Pre-populate the cumulative usage as if a prior subprocess already
    // ran on this session. New tracker constructed from non-zero state.
    // The delta returned by flushUsageDelta should ONLY include what THIS
    // tracker absorbed — not the prior subprocess's tokens.
    const cumulative: TokenUsage = {
      inputTokens: 500,
      outputTokens: 100,
      cachedReadTokens: 2000,
      cachedNonReadTokens: 0,
    };
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 1000, cached_input_tokens: 800, output_tokens: 40,
    }));
    const delta = tracker.flushUsageDelta();
    expect(delta.inputTokens).toBe(200);       // 1000 - 800 (this turn only)
    expect(delta.outputTokens).toBe(40);
    expect(delta.cachedReadTokens).toBe(800);  // this turn only
    // Cumulative now reflects both prior + this subprocess.
    expect(cumulative.inputTokens).toBe(700);  // 500 + 200
    expect(cumulative.cachedReadTokens).toBe(2800); // 2000 + 800
  });
});

describe('codex TurnTracker — cost-equivalence demonstration', () => {
  it('a real-world audit at 7.3M input / 6.66M cached produces NET input ≈ 0.65M', () => {
    // This pins the post-fix cost calculation matches the published rates.
    // Pre-fix: priceTokens(7.3M, 6.66M, 110K) = $21.60 (OVER-BILLED).
    // Post-fix: priceTokens(0.65M, 6.66M, 110K) = $4.95 (CORRECT — what
    // OpenAI actually charged).
    const cumulative = zeroUsage();
    const tracker = new TurnTracker(cumulative);
    tracker.consume(turnCompletedEvent({
      input_tokens: 7_307_816,
      cached_input_tokens: 6_661_888,
      output_tokens: 110_824,
    }));
    const delta = tracker.flushUsageDelta();
    expect(delta.inputTokens).toBe(645_928);
    expect(delta.cachedReadTokens).toBe(6_661_888);
    expect(delta.outputTokens).toBe(110_824);
  });
});

describe('codex consumeStream — settles on exit even if close never fires', () => {
  it('resolves the promise when proc emits exit, without waiting for close', async () => {
    // Simulates the 2026-05-16 leak: codex grandchildren inherit the
    // stdio pipes, so 'close' waits forever after the leader has exited.
    const fakeProc = new EventEmitter() as any;
    fakeProc.stdout = new PassThrough();
    fakeProc.stderr = new PassThrough();
    fakeProc.exitCode = null;

    const tracker = new (__test as any).TurnTracker(
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      undefined,
    );
    const stderrRef = { value: '' };
    const promise = (__test as any).consumeStream(fakeProc, tracker, stderrRef);

    // Leader terminates; pipes remain open (no 'close' will be emitted).
    fakeProc.exitCode = 0;
    fakeProc.emit('exit', 0, null);

    const timeoutToken = Symbol('timeout');
    const race = await Promise.race([
      promise.then(() => 'resolved' as const),
      new Promise((resolve) => setTimeout(() => resolve(timeoutToken), 500)),
    ]);
    expect(race).toBe('resolved');
  });

  it('still settles on close when exit never fires (e.g., spawn failure path)', async () => {
    const fakeProc = new EventEmitter() as any;
    fakeProc.stdout = new PassThrough();
    fakeProc.stderr = new PassThrough();
    fakeProc.exitCode = null;

    const tracker = new (__test as any).TurnTracker(
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      undefined,
    );
    const promise = (__test as any).consumeStream(fakeProc, tracker, { value: '' });

    fakeProc.emit('close');
    await expect(promise).resolves.toBeUndefined();
  });

  it('does not double-resolve when both exit and close fire', async () => {
    // Both fire in rapid succession on a healthy child — the parsed-buffer
    // side-effect (parseCodexCliEvent on residual stdoutBuf) must run once,
    // not twice.
    const fakeProc = new EventEmitter() as any;
    fakeProc.stdout = new PassThrough();
    fakeProc.stderr = new PassThrough();
    fakeProc.exitCode = 0;

    const tracker = new (__test as any).TurnTracker(
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      undefined,
    );
    const promise = (__test as any).consumeStream(fakeProc, tracker, { value: '' });

    fakeProc.emit('exit', 0, null);
    fakeProc.emit('close');
    await expect(promise).resolves.toBeUndefined();
  });
});
