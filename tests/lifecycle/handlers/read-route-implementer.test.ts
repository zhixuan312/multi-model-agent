import { describe, it, expect, vi } from 'vitest';
import { makeReadRouteImplementer } from '../../../packages/core/src/lifecycle/handlers/read-route-implementer.js';
import type { TurnResult } from '../../../packages/core/src/types/run-result.js';

function turn(output: string): TurnResult {
  return {
    output,
    usage: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [], filesWritten: [], toolCallsByName: {},
    turns: 1, durationMs: 0, costUSD: null,
    terminationReason: 'ok',
  };
}

describe('read-route-implementer', () => {
  it('calls session.send once per criterion and accumulates findings', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(turn('## Finding 1: A\n- Severity: high'))
      .mockResolvedValueOnce(turn('## Finding 1: B\n- Severity: low'))
      .mockResolvedValueOnce(turn('## Finding 1: C\n- Severity: medium'));
    const state: any = {
      task: { prompt: 'audit' },
      executionContext: { getSession: () => ({ send, close: vi.fn() }) },
    };
    const impl = makeReadRouteImplementer({
      criteria: [
        { id: '1', title: 'a', description: 'd' },
        { id: '2', title: 'b', description: 'd' },
        { id: '3', title: 'c', description: 'd' },
      ],
      buildSuffix: (c) => `criterion ${c.id}: ${c.title}`,
      route: 'audit',
    });
    await impl(state);
    expect(send).toHaveBeenCalledTimes(3);
    expect((state.lastRunResult as any).findings.map((f: any) => f.claim)).toEqual(['A', 'B', 'C']);
    expect((state.lastRunResult as any).criteriaErrors).toEqual([]);
  });

  it('records criteriaErrors on per-iteration failure and continues', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(turn('## Finding 1: ok'))
      .mockRejectedValueOnce(new Error('transport boom'))
      .mockResolvedValueOnce(turn('## Finding 1: ok2'));
    const state: any = {
      task: { prompt: 'audit' },
      executionContext: { getSession: () => ({ send, close: vi.fn() }) },
    };
    const impl = makeReadRouteImplementer({
      criteria: [
        { id: '1', title: 'a', description: 'd' },
        { id: '2', title: 'b', description: 'd' },
        { id: '3', title: 'c', description: 'd' },
      ],
      buildSuffix: (c) => `c${c.id}`,
      route: 'audit',
    });
    await impl(state);
    const last = state.lastRunResult as any;
    expect(last.findings).toHaveLength(2);
    expect(last.criteriaErrors).toHaveLength(1);
    expect(last.criteriaErrors[0]).toMatchObject({
      criterionId: '2',
      error: expect.stringMatching(/transport boom/),
    });
  });
});
