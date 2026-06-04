import { describe, it, expect, vi } from 'vitest';
import { runReadRouteImplementer } from '../../packages/core/src/lifecycle/handlers/read-route-implementer.js';

describe('runReadRouteImplementer — outcome aggregation', () => {
  it('aggregates per-criterion outcomes by precedence found > not_applicable > clean', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ output: '## Outcome\nclean', usage: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'ok' })
      .mockResolvedValueOnce({ output: '## Outcome\nfound', usage: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'ok' })
      .mockResolvedValueOnce({ output: '## Outcome\nnot_applicable — project-level', usage: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'ok' });

    const result = await runReadRouteImplementer({
      session: { send } as any,
      cachedPrefix: 'prefix',
      criteria: [{ id: 'c1', title: 'a', description: '' }, { id: 'c2', title: 'b', description: '' }, { id: 'c3', title: 'c', description: '' }],
      buildSuffix: () => 'suffix',
      legalOutcomes: ['found', 'clean'] as const,
    });
    expect(result.findingsOutcome).toBe('found');
  });

  it('concatenates not_applicable reasons with semicolon separator', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ output: '## Outcome\nnot_applicable — reason A', usage: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'ok' })
      .mockResolvedValueOnce({ output: '## Outcome\nnot_applicable — reason B', usage: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'ok' });

    const result = await runReadRouteImplementer({
      session: { send } as any,
      cachedPrefix: 'prefix',
      criteria: [{ id: 'c1', title: 'a', description: '' }, { id: 'c2', title: 'b', description: '' }],
      buildSuffix: () => 'suffix',
      // Test the not_applicable aggregation path — route must legally allow it.
      legalOutcomes: ['found', 'clean', 'not_applicable'] as const,
    });
    expect(result.findingsOutcome).toBe('not_applicable');
    expect(result.findingsOutcomeReason).toBe('reason A; reason B');
  });

  it('drops reason for clean and found outcomes', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ output: '## Outcome\nfound', usage: {}, turns: 1, durationMs: 0, costUSD: 0, terminationReason: 'ok' });

    const result = await runReadRouteImplementer({
      session: { send } as any,
      cachedPrefix: 'prefix',
      criteria: [{ id: 'c1', title: 'a', description: '' }],
      buildSuffix: () => 'suffix',
      legalOutcomes: ['found', 'clean'] as const,
    });
    expect(result.findingsOutcomeReason).toBeNull();
  });
});
