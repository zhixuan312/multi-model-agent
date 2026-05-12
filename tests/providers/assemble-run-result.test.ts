import { describe, it, expect } from 'vitest';
import { assembleRunResult } from '../../packages/core/src/providers/assemble-run-result.js';
import type { TurnResult } from '../../packages/core/src/types/run-result.js';

function turn(o: Partial<TurnResult> = {}): TurnResult {
  return {
    output: 'done',
    usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [],
    filesWritten: [],
    toolCallsByName: {},
    turns: 1,
    durationMs: 1000,
    costUSD: 0.001,
    terminationReason: 'ok',
    ...o,
  };
}

describe('assembleRunResult', () => {
  it('copies machine-readable fields from TurnResult', () => {
    const r = assembleRunResult(turn({ filesWritten: ['a.ts'], turns: 3 }));
    expect(r.output).toBe('done');
    expect(r.filesWritten).toEqual(['a.ts']);
    expect(r.turns).toBe(3);
    expect(r.actualCostUSD).toBe(0.001);
    expect(r.status).toBe('ok');
  });
  it('merges parsed report fields', () => {
    const r = assembleRunResult(turn(), { reviewVerdict: 'approved' });
    expect(r.reviewVerdict).toBe('approved');
  });
  it('maps termination reasons to lifecycle statuses', () => {
    const r = assembleRunResult(turn({ terminationReason: 'time_exceeded' }));
    expect(r.status).toBe('timeout');
    expect(r.terminationReason).toBe('time_ceiling');
  });
  it('flattens toolCallsByName into toolCalls string[]', () => {
    const r = assembleRunResult(turn({ toolCallsByName: { Read: 2, Edit: 1 } }));
    expect(r.toolCalls.length).toBe(3);
    expect(r.toolCalls.filter(t => t === 'Read').length).toBe(2);
  });
  it('parsedFindings is undefined unless parsed', () => {
    const r = assembleRunResult(turn());
    expect(r.parsedFindings).toBeUndefined();
  });
});
