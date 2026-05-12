import { describe, it, expect, vi } from 'vitest';
import { reviewHandler } from '../../../packages/core/src/lifecycle/handlers/review-handler.js';
import { WARM_FOLLOWUP_PREAMBLE } from '../../../packages/core/src/lifecycle/warm-followup.js';
import type { TurnResult } from '../../../packages/core/src/types/run-result.js';

function fakeTurn(output: string): TurnResult {
  return {
    output,
    usage: { inputTokens: 10, outputTokens: 10, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [], filesWritten: [], toolCallsByName: {},
    turns: 1, durationMs: 0, costUSD: null,
    terminationReason: 'ok',
  } as unknown as TurnResult;
}

describe('reviewHandler — warm-followup contract', () => {
  it('iteration 0 (spec) sends cold-open prompt; iteration 1 (quality) sends warm-followup', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(fakeTurn('## Verdict\napproved\n## Deviations\n(none)'))
      .mockResolvedValueOnce(fakeTurn('## Verdict\napproved\n## Deviations\n(none)'));
    const session = { send, close: vi.fn() } as any;
    const ctx: any = {
      assignedTier: 'standard',
      providers: { standard: { config: {} }, complex: { config: {} } },
      getSession: vi.fn().mockReturnValue(session),
    };
    const state: any = {
      executionContext: ctx,
      task: { prompt: 'BRIEF_77123' },
      lastRunResult: { output: 'WORKER_OUTPUT_43891' },
      reviewPolicy: 'full',
      diffTracker: { cumulativeDiff: async () => 'DIFF_29348' },
    };
    await reviewHandler(state);
    expect(send).toHaveBeenCalledTimes(2);
    // turn 0 (spec): cold open — contains the brief verbatim, does NOT start with the warm preamble.
    expect(send.mock.calls[0][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(false);
    expect(send.mock.calls[0][0]).toContain('BRIEF_77123');
    // turn 1 (quality): warm follow-up — starts with preamble, does NOT include the brief / diff body.
    expect(send.mock.calls[1][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(true);
    expect(send.mock.calls[1][0]).not.toContain('BRIEF_77123');
    expect(send.mock.calls[1][0]).not.toContain('DIFF_29348');
  });

  it('rotated-session fallback — if the session reference changes between iterations, iteration 1 sends cold-open instead of warm-followup', async () => {
    const send1 = vi.fn().mockResolvedValueOnce(fakeTurn('## Verdict\napproved\n## Deviations\n(none)'));
    const send2 = vi.fn().mockResolvedValueOnce(fakeTurn('## Verdict\napproved\n## Deviations\n(none)'));
    const session1 = { send: send1, close: vi.fn() } as any;
    const session2 = { send: send2, close: vi.fn() } as any;
    const ctx: any = {
      assignedTier: 'standard',
      providers: { standard: { config: {} }, complex: { config: {} } },
      getSession: vi.fn()
        .mockReturnValueOnce(session1)
        .mockReturnValueOnce(session2)
        .mockReturnValueOnce(session2),
    };
    const state: any = {
      executionContext: ctx,
      task: { prompt: 'BRIEF_77123' },
      lastRunResult: { output: 'WORKER_OUTPUT_43891' },
      reviewPolicy: 'full',
      diffTracker: { cumulativeDiff: async () => 'DIFF_29348' },
    };
    await reviewHandler(state);
    // Cold open on both calls — second session is fresh, no warm follow-up allowed.
    expect(send1.mock.calls[0][0]).toContain('BRIEF_77123');
    expect(send2.mock.calls[0][0].startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(false);
    expect(send2.mock.calls[0][0]).toContain('BRIEF_77123');
  });
});
