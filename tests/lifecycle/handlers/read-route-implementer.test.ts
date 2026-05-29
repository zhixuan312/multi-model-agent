import { describe, it, expect, vi } from 'bun:test';
import { runReadRouteImplementer } from '../../../packages/core/src/lifecycle/handlers/read-route-implementer.js';
import { WARM_FOLLOWUP_PREAMBLE } from '../../../packages/core/src/lifecycle/warm-followup.js';
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

describe('runReadRouteImplementer', () => {
  it('sends prefix with first criterion only and accumulates findings', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(turn('## Finding 1: A\n- Severity: high'))
      .mockResolvedValueOnce(turn('## Finding 1: B\n- Severity: low'))
      .mockResolvedValueOnce(turn('## Finding 1: C\n- Severity: medium'));
    const session = { send, close: vi.fn() } as any;
    const result = await runReadRouteImplementer({
      session,
      cachedPrefix: 'PREFIX',
      criteria: [
        { id: '1', title: 'a', description: 'd' },
        { id: '2', title: 'b', description: 'd' },
        { id: '3', title: 'c', description: 'd' },
      ],
      buildSuffix: (c) => `criterion ${c.id}: ${c.title}`,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toContain('PREFIX');
    expect(send.mock.calls[1][0]).not.toContain('PREFIX');
    expect(result.findings.map((f) => f.claim)).toEqual(['A', 'B', 'C']);
    expect(result.criteriaErrors).toEqual([]);
    expect(result.synthesizedOutput).toContain('--- a (criterion 1) ---');
  });

  it('records criteriaErrors on per-iteration failure and continues', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(turn('## Finding 1: ok'))
      .mockRejectedValueOnce(new Error('transport boom'))
      .mockResolvedValueOnce(turn('## Finding 1: ok2'));
    const session = { send, close: vi.fn() } as any;
    const result = await runReadRouteImplementer({
      session,
      cachedPrefix: 'PFX',
      criteria: [
        { id: '1', title: 'a', description: 'd' },
        { id: '2', title: 'b', description: 'd' },
        { id: '3', title: 'c', description: 'd' },
      ],
      buildSuffix: (c) => `c${c.id}`,
    });
    expect(result.findings).toHaveLength(2);
    expect(result.criteriaErrors).toHaveLength(1);
    expect(result.criteriaErrors[0]).toMatchObject({
      criterionId: '2',
      error: expect.stringMatching(/transport boom/),
    });
  });
});

describe('runReadRouteImplementer warm-followup contract', () => {
  it('iteration 0 prompt does not start with the warm-followup preamble', async () => {
    const send = vi.fn().mockResolvedValue(turn('## Finding 1: ok'));
    const session = { send, close: vi.fn() } as any;
    await runReadRouteImplementer({
      session,
      cachedPrefix: 'PREFIX',
      criteria: [{ id: '1', title: 'a', description: 'd' }],
      buildSuffix: (c) => `criterion ${c.id}`,
    });
    expect(send.mock.calls[0][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(false);
    // sanity — turn 0 still carries the cached prefix
    expect(send.mock.calls[0][0]).toContain('PREFIX');
  });

  it('iterations 1..N prompts start with the warm-followup preamble', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(turn('## Finding 1: a'))
      .mockResolvedValueOnce(turn('## Finding 1: b'))
      .mockResolvedValueOnce(turn('## Finding 1: c'));
    const session = { send, close: vi.fn() } as any;
    await runReadRouteImplementer({
      session,
      cachedPrefix: 'PREFIX',
      criteria: [
        { id: '1', title: 'a', description: 'd' },
        { id: '2', title: 'b', description: 'd' },
        { id: '3', title: 'c', description: 'd' },
      ],
      buildSuffix: (c) => `criterion ${c.id}`,
    });
    expect(send.mock.calls[0][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(false);
    expect(send.mock.calls[1][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(true);
    expect(send.mock.calls[2][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(true);
    // turns 1..N are preamble + suffix, nothing else
    expect(send.mock.calls[1][0]).toBe(`${WARM_FOLLOWUP_PREAMBLE}\n\ncriterion 2`);
    expect(send.mock.calls[2][0]).toBe(`${WARM_FOLLOWUP_PREAMBLE}\n\ncriterion 3`);
  });
});
