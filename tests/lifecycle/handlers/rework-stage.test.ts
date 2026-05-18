import { describe, it, expect, vi } from 'vitest';
import { reworkHandler } from '../../../packages/core/src/lifecycle/handlers/rework-stage.js';
import { WARM_FOLLOWUP_PREAMBLE } from '../../../packages/core/src/lifecycle/warm-followup.js';
import type { TurnResult } from '../../../packages/core/src/types/run-result.js';

function fakeTurn(output: string, extra?: Partial<TurnResult>): TurnResult {
  return {
    output,
    usage: { inputTokens: 10, outputTokens: 10, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [], filesWritten: [], toolCallsByName: {},
    turns: 1, durationMs: 0, costUSD: null,
    terminationReason: 'ok',
    ...extra,
  } as unknown as TurnResult;
}

const REWORK_WORKER_OUTPUT = [
  '```json',
  JSON.stringify({
    summary: 'fixed both deviations',
    workerStatus: 'done',
    filesChanged: ['src/foo.ts'],
    unresolved: [],
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
    config: {
      defaults: {
        progressWatchdogEnabled: false,
        thrashTurns: 20,
        thrashWallClockMs: 300_000,
      },
    },
    taskIndex: 0,
    batchId: undefined,
    bus: { emit: vi.fn() },
    stall: { controller: new AbortController() },
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
      toolCategory: 'artifact_producing',
      cwd: '/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent',
      preTaskHeadSha: 'a'.repeat(40),
      preTaskUntrackedFiles: new Set<string>(),
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

  // Cost-attribution regression pin (2026-05-12): assembleRunResult writes
  // the per-turn cost to `actualCostUSD`, NOT a `costUSD` field on RunResult.
  // The rework handler previously read `result.costUSD` (the wrong field
  // name) and recorded cost=null for every claude-tier rework stage, making
  // telemetry under-report. Pin the correct field lookup here so a future
  // refactor doesn't silently zero-out the cost again.
  it('records cost in stageStats from RunResult.actualCostUSD (not a legacy costUSD field)', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      ...fakeTurn(REWORK_WORKER_OUTPUT),
      costUSD: 0.1234, // the TurnResult-level cost flows into actualCostUSD
                       // on the assembled RunResult; this is what we expect
                       // mergeStageStats to record.
    } as unknown as TurnResult);
    const openSessionSpy = vi.fn();
    const { state } = makeState(send, openSessionSpy);
    await reworkHandler(state);
    // mergeStageStats writes to `state.lastRunResult.stageStats` (not
    // `state.stageStats`) — it lives on the run result so it survives the
    // replaceLastRunResultPreservingTrackers merge in the rework handler.
    const last = state.lastRunResult as { stageStats?: Record<string, { costUSD?: number | null }> };
    expect(last.stageStats?.['rework']?.costUSD).toBeCloseTo(0.1234, 6);
  });
});

// Structural test: the rework handler must call startProgressWatchdog +
// recordPostHocSignals around its session.send. Asserting the watchdog
// signals end-to-end requires mocking node:child_process (git), which is
// covered by the bounded-execution/progress-watchdog unit tests. Here we
// just check the integration disposes cleanly without breaking the existing
// rework flow (passes when reworkHandler still wires its session correctly).
describe('reworkHandler — progress watchdog wiring (smoke)', () => {
  it('runs to completion with watchdog wired and reviewVerdict approved-by-default', async () => {
    const send = vi.fn().mockResolvedValueOnce(fakeTurn(REWORK_WORKER_OUTPUT, { turns: 5 }));
    const ctx: any = {
      assignedTier: 'standard',
      providers: { standard: { config: {} }, complex: { config: {} } },
      getSession: vi.fn().mockReturnValue({ send, close: vi.fn() }),
      config: { defaults: { progressWatchdogEnabled: false } }, // bypass the timer
      taskIndex: 0,
      bus: { emit: vi.fn() },
      stall: { controller: new AbortController() },
    };
    const state: any = {
      executionContext: ctx,
      task: { prompt: 'BRIEF', planContext: 'PLAN' },
      lastRunResult: { output: 'IMPL_OUTPUT' },
      reviewVerdict: 'changes_required',
      reviewFindings: [{ source: 'quality', text: 'concern' }],
      diffTracker: { cumulativeDiff: async () => 'DIFF' },
      toolCategory: 'artifact_producing',
    };
    await reworkHandler(state);
    expect(send).toHaveBeenCalled();
    // Existing rework flow still produces a result; the new wiring didn't break it.
    expect(state.reworkError).toBeUndefined();
  });
});