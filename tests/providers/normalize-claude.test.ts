import { describe, it, expect } from 'vitest';
import { normalizeClaudeTurn } from '../../packages/core/src/providers/normalize-claude.js';

const asst = (text: string) =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as any;
const tool = (name: string, input: object) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }) as any;
const result = (subtype: string, usage: object = {}, extras: object = {}) =>
  ({ type: 'result', subtype, usage, ...extras }) as any;

describe('normalizeClaudeTurn', () => {
  it('extracts assistant text from assistant events', () => {
    const r = normalizeClaudeTurn(
      [asst('hello '), asst('world'), result('success', { input_tokens: 100, output_tokens: 50 })],
      { durationMs: 1, costUSD: 0.001 },
    );
    expect(r.output).toBe('hello world');
    expect(r.terminationReason).toBe('ok');
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(50);
  });
  it('records Edit tool as filesWritten', () => {
    const r = normalizeClaudeTurn(
      [tool('Edit', { file_path: 'x.ts' }), result('success')],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.filesWritten).toEqual(['x.ts']);
  });
  it('records Bash tool as usedShell', () => {
    const r = normalizeClaudeTurn(
      [tool('Bash', { command: 'ls -la' }), result('success')],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.usedShell).toBe(true);
  });
  it('terminationReason ok from success', () => {
    const r = normalizeClaudeTurn(
      [result('success')],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.terminationReason).toBe('ok');
  });
  it('terminationReason error from error_during_execution', () => {
    const r = normalizeClaudeTurn(
      [result('error_during_execution', {}, { error: { message: 'Invalid API key for Anthropic' } })],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.terminationReason).toBe('error');
    expect(r.errorCode).toBe('sdk_execution_error');
    expect(r.errorMessage).toBe('Invalid API key for Anthropic');
  });
  it('error_max_turns maps to terminationReason=error + errorCode=sdk_max_turns', () => {
    const r = normalizeClaudeTurn(
      [result('error_max_turns')],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.terminationReason).toBe('error');
    expect(r.errorCode).toBe('sdk_max_turns');
  });
  it('terminationReason time_exceeded from guardTerminationReason', () => {
    const r = normalizeClaudeTurn(
      [result('success')],
      { durationMs: 1, costUSD: 0, guardTerminationReason: 'time_exceeded' },
    );
    expect(r.terminationReason).toBe('time_exceeded');
  });
  it('terminationReason stalled from guardTerminationReason', () => {
    const r = normalizeClaudeTurn(
      [result('success')],
      { durationMs: 1, costUSD: 0, guardTerminationReason: 'stalled' },
    );
    expect(r.terminationReason).toBe('stalled');
  });
  it('terminationReason aborted from guardTerminationReason', () => {
    const r = normalizeClaudeTurn(
      [result('success')],
      { durationMs: 1, costUSD: 0, guardTerminationReason: 'aborted' },
    );
    expect(r.terminationReason).toBe('aborted');
  });
});

// Cross-provider TokenUsage contract pin (anthropic side).
// Anthropic's Messages API emits input_tokens / cache_read_input_tokens /
// cache_creation_input_tokens as THREE DISJOINT BUCKETS — each prompt
// token counted in exactly one. Our adapter is pass-through; this test
// pins the disjoint semantics so a future "normalize" or "sum together"
// regression would fail.
describe('normalizeClaudeTurn — TokenUsage disjoint-partition contract', () => {
  it('treats input_tokens / cache_read_input_tokens / cache_creation_input_tokens as disjoint buckets', () => {
    const r = normalizeClaudeTurn(
      [result('success', {
        input_tokens: 100,           // ← NET (post-breakpoint) per Anthropic docs
        output_tokens: 50,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 200,
      })],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(50);
    expect(r.usage.cachedReadTokens).toBe(700);
    expect(r.usage.cachedNonReadTokens).toBe(200);
    // The four fields should NOT have been merged or double-counted.
    // Total prompt = 100 + 700 + 200 = 1000 if we add them; our adapter
    // stores them disjoint and `priceTokens` applies separate rates.
  });

  it('handles a turn with cache writes but no reads (first-time cache fill)', () => {
    const r = normalizeClaudeTurn(
      [result('success', {
        input_tokens: 50,
        output_tokens: 25,
        cache_creation_input_tokens: 900,
        // cache_read_input_tokens omitted (first request, nothing to read)
      })],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.usage.inputTokens).toBe(50);
    expect(r.usage.cachedReadTokens).toBe(0);
    expect(r.usage.cachedNonReadTokens).toBe(900);
  });

  // ── 'ok' must be earned by an explicit success result ──────────────────────
  // A dead tier (unreachable proxy, auth rejection, crashed SDK subprocess)
  // yields an empty or result-less event stream. Reporting 'ok' for that is
  // what masked a dead implementer as a successful turn.
  describe("dead-stream guard ('ok' is earned, never defaulted)", () => {
    it('empty event stream is an error (sdk_no_result), not ok', () => {
      const r = normalizeClaudeTurn([], { durationMs: 1, costUSD: 0 });
      expect(r.terminationReason).toBe('error');
      expect(r.errorCode).toBe('sdk_no_result');
      expect(r.errorMessage).toMatch(/without a result event/);
    });

    it('assistant events without a terminal result event are an error', () => {
      const r = normalizeClaudeTurn(
        [asst('partial output before the stream died')],
        { durationMs: 1, costUSD: 0 },
      );
      expect(r.terminationReason).toBe('error');
      expect(r.errorCode).toBe('sdk_no_result');
      // Partial output is preserved as evidence.
      expect(r.output).toBe('partial output before the stream died');
    });

    it('guardTerminationReason takes precedence over the dead-stream guard', () => {
      // Deadline-closed stream with zero events: the wall-clock guard owns the
      // reason; sdk_no_result must not overwrite it.
      const r = normalizeClaudeTurn([], { durationMs: 1, costUSD: 0, guardTerminationReason: 'time_exceeded' });
      expect(r.terminationReason).toBe('time_exceeded');
      expect(r.errorCode).toBeUndefined();
    });

    it('unknown non-success result subtype is an error (future SDK variants)', () => {
      const r = normalizeClaudeTurn(
        [result('error_some_future_variant')],
        { durationMs: 1, costUSD: 0 },
      );
      expect(r.terminationReason).toBe('error');
      expect(r.errorCode).toBe('sdk_error_some_future_variant');
    });
  });
});
