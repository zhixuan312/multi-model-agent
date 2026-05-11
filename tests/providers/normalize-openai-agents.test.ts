import { describe, it, expect } from 'vitest';
import { normalizeOpenAIAgentsRun } from '../../packages/core/src/providers/normalize-openai-agents.js';

const fake = (over: object = {}) => ({ finalOutput: 'done', rawResponses: [], newItems: [], ...over });

describe('normalizeOpenAIAgentsRun', () => {
  it('extracts finalOutput', () => {
    const r = normalizeOpenAIAgentsRun(fake(), { durationMs: 100, costUSD: 0 });
    expect(r.output).toBe('done');
    expect(r.terminationReason).toBe('ok');
  });
  it('sums usage across rawResponses', () => {
    const r = normalizeOpenAIAgentsRun(fake({
      rawResponses: [
        { usage: { inputTokens: 100, outputTokens: 50 } },
        { usage: { inputTokens: 80, outputTokens: 40, inputTokensDetails: { cachedTokens: 60 } } },
      ],
    }), { durationMs: 100, costUSD: 0 });
    expect(r.usage.inputTokens).toBe(180);
    expect(r.usage.outputTokens).toBe(90);
    expect(r.usage.cachedReadTokens).toBe(60);
    expect(r.turns).toBe(2);
  });
  it('handles inputTokensDetails as an array', () => {
    const r = normalizeOpenAIAgentsRun(fake({
      rawResponses: [
        { usage: { inputTokens: 50, outputTokens: 20, inputTokensDetails: [{ cachedTokens: 30 }, { cachedTokens: 5 }] } },
      ],
    }), { durationMs: 100, costUSD: 0 });
    expect(r.usage.cachedReadTokens).toBe(35);
  });
  it('records read_file as filesRead', () => {
    const r = normalizeOpenAIAgentsRun(fake({
      newItems: [{ type: 'tool_call_item', rawItem: { name: 'read_file', arguments: { path: '/x.ts' } } }],
    }), { durationMs: 100, costUSD: 0 });
    expect(r.filesRead).toEqual(['/x.ts']);
    expect(r.toolCallsByName.read_file).toBe(1);
  });
  it('records apply_patch operations as filesWritten', () => {
    const r = normalizeOpenAIAgentsRun(fake({
      newItems: [{ type: 'tool_call_item', rawItem: { name: 'apply_patch', arguments: { operations: [{ path: 'a.ts' }, { path: 'b.ts' }] } } }],
    }), { durationMs: 100, costUSD: 0 });
    expect(r.filesWritten.sort()).toEqual(['a.ts', 'b.ts']);
  });
  it('SDK errorCode maps to terminationReason=error', () => {
    const r = normalizeOpenAIAgentsRun(fake({ errorCode: 'rate_limited' }), { durationMs: 100, costUSD: 0 });
    expect(r.terminationReason).toBe('error');
    expect(r.errorCode).toBe('rate_limited');
  });
  it('guard wins over SDK terminal', () => {
    const r = normalizeOpenAIAgentsRun(fake({ errorCode: 'rate_limited' }), { durationMs: 100, costUSD: 0, guardTerminationReason: 'aborted' });
    expect(r.terminationReason).toBe('aborted');
  });
});
