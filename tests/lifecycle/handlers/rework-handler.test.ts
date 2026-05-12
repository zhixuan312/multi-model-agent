import { describe, it, expect, vi } from 'vitest';
import { reworkHandler } from '../../../packages/core/src/lifecycle/handlers/rework-handler.js';
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

const REWORK_WORKER_OUTPUT = [
  '```json',
  JSON.stringify({
    summary: 'fixed both deviations',
    workerStatus: 'done',
    filesChanged: ['src/foo.ts'],
    unresolved: [],
    validationsRun: [],
  }),
  '```',
].join('\n');

function makeState(send: ReturnType<typeof vi.fn>, openSessionSpy: ReturnType<typeof vi.fn>) {
  const session = { send, close: vi.fn() } as any;
  const ctx: any = {
    assignedTier: 'standard',
    providers: {
      standard: { config: {}, openSession: openSessionSpy },
      complex: { config: {} },
    },
    getSession: vi.fn().mockReturnValue(session),
  };
  return {
    ctx,
    state: {
      executionContext: ctx,
      task: { prompt: 'BRIEF_77123', planContext: 'PLAN_55421' },
      lastRunResult: { output: 'WORKER_OUTPUT_43891' },
      reviewVerdict: 'changes_required',
      reviewFindings: [{ source: 'quality', text: 'concern_one_sentinel_88' }],
      diffTracker: { cumulativeDiff: async () => 'DIFF_29348' },
    } as any,
  };
}

describe('reworkHandler — warm-followup contract', () => {
  it('sends a prompt that starts with the warm-followup preamble and excludes brief / diff / workerOutput / planContext', async () => {
    const send = vi.fn().mockResolvedValueOnce(fakeTurn(REWORK_WORKER_OUTPUT));
    const openSessionSpy = vi.fn();
    const { state } = makeState(send, openSessionSpy);
    await reworkHandler(state);
    expect(send).toHaveBeenCalledTimes(1);
    const prompt = send.mock.calls[0][0] as string;
    expect(prompt.startsWith(WARM_FOLLOWUP_PREAMBLE)).toBe(true);
    expect(prompt).not.toContain('BRIEF_77123');
    expect(prompt).not.toContain('WORKER_OUTPUT_43891');
    expect(prompt).not.toContain('DIFF_29348');
    expect(prompt).not.toContain('PLAN_55421');
    expect(prompt).toContain('concern_one_sentinel_88');
  });

  it('does not include the reworkTemplate.systemPrompt — it lives in the resumed thread already', async () => {
    const send = vi.fn().mockResolvedValueOnce(fakeTurn(REWORK_WORKER_OUTPUT));
    const openSessionSpy = vi.fn();
    const { state } = makeState(send, openSessionSpy);
    await reworkHandler(state);
    const prompt = send.mock.calls[0][0] as string;
    expect(prompt).not.toContain('You are the REWORK worker');
  });

  it('resume-failure branch — when session.send throws, the handler surfaces the error and does NOT call provider.openSession again', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('resume_failed: thread not found'));
    const openSessionSpy = vi.fn();
    const { state } = makeState(send, openSessionSpy);
    await reworkHandler(state);
    expect(state.reworkError).toMatch(/resume_failed/);
    expect(openSessionSpy).not.toHaveBeenCalled();
    expect(state.reworkApplied).toBeUndefined();
  });
});
