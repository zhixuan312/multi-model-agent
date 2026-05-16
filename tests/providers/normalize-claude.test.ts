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
  it('records Read tool as filesRead', () => {
    const r = normalizeClaudeTurn(
      [tool('Read', { file_path: '/a/b.ts' }), result('success')],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.filesRead).toEqual(['/a/b.ts']);
    expect(r.toolCallsByName.Read).toBe(1);
  });
  it('records Edit tool as filesWritten', () => {
    const r = normalizeClaudeTurn(
      [tool('Edit', { file_path: 'x.ts' }), result('success')],
      { durationMs: 1, costUSD: 0 },
    );
    expect(r.filesWritten).toEqual(['x.ts']);
  });
  it('max_turns maps to error/sdk_max_turns', () => {
    const r = normalizeClaudeTurn([result('error_max_turns')], { durationMs: 1, costUSD: 0 });
    expect(r.terminationReason).toBe('error');
    expect(r.errorCode).toBe('sdk_max_turns');
  });
  it('max_budget maps to cost_exceeded/sdk_max_budget', () => {
    const r = normalizeClaudeTurn([result('error_max_budget_usd')], { durationMs: 1, costUSD: 0 });
    expect(r.terminationReason).toBe('cost_exceeded');
    expect(r.errorCode).toBe('sdk_max_budget');
  });
  it('max_budget maps to error/sdk_max_budget', () => {
    const r = normalizeClaudeTurn([result('error_max_budget_usd')], { durationMs: 1, costUSD: 0 });
    expect(r.terminationReason).toBe('error');
    expect(r.errorCode).toBe('sdk_max_budget');
  });
  it('guard override wins over SDK terminal', () => {
    const r = normalizeClaudeTurn(
      [result('success')],
      { durationMs: 1, costUSD: 0, guardTerminationReason: 'time_exceeded' },
    );
    expect(r.terminationReason).toBe('time_exceeded');
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
});
