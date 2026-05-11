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
  it('guard override wins over SDK terminal', () => {
    const r = normalizeClaudeTurn(
      [result('success')],
      { durationMs: 1, costUSD: 0, guardTerminationReason: 'time_exceeded' },
    );
    expect(r.terminationReason).toBe('time_exceeded');
  });
});
