import { describe, it, expect, vi } from 'vitest';
import { dispatchParallelCriteria } from '../../packages/core/src/lifecycle/parallel-criteria-dispatcher.js';
import type { CriterionEntry } from '../../packages/core/src/tools/criteria-types.js';
import type { Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';

const CRITERIA: readonly CriterionEntry[] = [
  { id: '1', title: 'A', description: 'first criterion description text more than twenty chars' },
  { id: '2', title: 'B', description: 'second criterion description text more than twenty chars' },
  { id: '3', title: 'C', description: 'third criterion description text more than twenty chars' },
];

const buildSuffix = (c: CriterionEntry) => `Your assignment: criterion ${c.id} — "${c.title}". ${c.description}`;

interface MockTurn { status: 'ok' | 'error'; output: string; }

function makeOpenSession(perCriterion: Record<string, MockTurn | ((opts: SessionOpts) => Promise<TurnResult>)>): {
  openSession: (opts: SessionOpts) => Session;
  sendCalls: number;
  closeCalls: number;
} {
  let sendCalls = 0;
  let closeCalls = 0;
  const factory = {
    openSession(_opts: SessionOpts): Session {
      return {
        async send(instruction: string): Promise<TurnResult> {
          sendCalls++;
          const id = instruction.match(/criterion (\d+)/)?.[1] ?? '?';
          const entry = perCriterion[id];
          if (!entry) throw new Error(`unmocked criterion ${id}`);
          if (typeof entry === 'function') return entry(_opts);
          return {
            output: entry.output,
            terminationReason: entry.status === 'ok' ? 'ok' : 'error',
            ...(entry.status === 'error' && { errorCode: 'transport_failure' as const }),
            usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 80, cachedNonReadTokens: 0 },
            turns: 1,
            toolCallsByName: {},
            filesRead: [],
            filesWritten: [],
            durationMs: 50,
            costUSD: 0.01,
            stallDetected: false,
          };
        },
        async close() { closeCalls++; },
      };
    },
    get sendCalls() { return sendCalls; },
    get closeCalls() { return closeCalls; },
  };
  return factory as any;
}

describe('dispatchParallelCriteria', () => {
  it('dispatches N sub-workers in parallel and closes each session', async () => {
    const f = makeOpenSession({
      '1': { status: 'ok', output: '## Finding 1: thing one' },
      '2': { status: 'ok', output: 'No findings for this criterion.' },
      '3': { status: 'ok', output: '## Finding 1: thing three' },
    });
    const result = await dispatchParallelCriteria({
      openSession: f.openSession,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
    });
    expect(f.sendCalls).toBe(3);
    expect(f.closeCalls).toBe(3);
    expect(result.partialCriteriaCovered).toEqual(['1', '2', '3']);
    expect(result.partialCriteriaFailed).toEqual([]);
    expect(result.workerOutputs).toHaveLength(3);
    expect(result.totalUsage.inputTokens).toBe(300);
    expect(result.totalUsage.cachedReadTokens).toBe(240);
    expect(result.cacheHitConfirmed).toBe(true);
  });

  it('retries failed sub-workers exactly once', async () => {
    let call2Count = 0;
    const perCriterion: Record<string, MockTurn | ((opts: SessionOpts) => Promise<TurnResult>)> = {
      '1': { status: 'ok', output: '## Finding 1: ok 1' },
      '2': async () => {
        call2Count++;
        if (call2Count === 1) {
          return {
            output: '',
            terminationReason: 'error',
            errorCode: 'transport_failure',
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 0,
            toolCallsByName: {},
            filesRead: [],
            filesWritten: [],
            durationMs: 10,
            costUSD: 0,
            stallDetected: false,
          };
        }
        return {
          output: '## Finding 1: recovered after retry',
          terminationReason: 'ok',
          usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 100, cachedNonReadTokens: 0 },
          turns: 1,
          toolCallsByName: {},
          filesRead: [],
          filesWritten: [],
          durationMs: 30,
          costUSD: 0.005,
          stallDetected: false,
        };
      },
      '3': { status: 'ok', output: '## Finding 1: ok 3' },
    };
    const f = makeOpenSession(perCriterion);
    const result = await dispatchParallelCriteria({
      openSession: f.openSession,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
    });
    expect(call2Count).toBe(2);
    expect(result.partialCriteriaCovered.sort()).toEqual(['1', '2', '3']);
    expect(result.partialCriteriaFailed).toEqual([]);
  });

  it('fail-soft: when retries also fail, drops from coverage and records failure with reason', async () => {
    const f = makeOpenSession({
      '1': { status: 'ok', output: '## Finding 1: ok' },
      '2': { status: 'error', output: '' },
      '3': { status: 'ok', output: '## Finding 1: ok' },
    });
    const result = await dispatchParallelCriteria({
      openSession: f.openSession,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
    });
    expect(result.partialCriteriaCovered).toEqual(['1', '3']);
    expect(result.partialCriteriaFailed).toHaveLength(1);
    expect(result.partialCriteriaFailed[0]).toEqual({
      id: '2',
      title: 'B',
      reason: 'transport',
      lastError: 'transport_failure',
    });
  });

  it('per-angle 10-minute hard cap aborts the worker and synthesizes a [N/A] finding', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    try {
      const events: any[] = [];
      const bus = { on: vi.fn(), emit: (e: any) => events.push(e) } as any;
      const f = makeOpenSession({
        '1': { status: 'ok', output: '## Finding 1: ok 1\n- Severity: medium\n- Issue: x\n' },
        '2': async (opts: SessionOpts) => {
          await new Promise<void>((resolve) => {
            opts.abortSignal!.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            output: '',
            terminationReason: 'error',
            errorCode: 'aborted',
            usage: { inputTokens: 100, outputTokens: 0, cachedReadTokens: 50, cachedNonReadTokens: 0 },
            turns: 5,
            toolCallsByName: {},
            filesRead: [],
            filesWritten: [],
            durationMs: 600_000,
            costUSD: 0.05,
            stallDetected: false,
          };
        },
        '3': { status: 'ok', output: '## Finding 1: ok 3\n- Severity: medium\n- Issue: x\n' },
      });

      const dispatched = dispatchParallelCriteria({
        openSession: f.openSession,
        cachedPrefix: 'PREFIX',
        criteria: CRITERIA,
        buildSuffix,
        cwd: '/tmp',
        bus,
      });
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      const result = await dispatched;

      expect(events.find(e => e.event === 'criteria_subworker_soft_warning' && e.criterionId === '2')).toBeDefined();
      expect(events.find(e => e.event === 'criteria_subworker_hard_cap' && e.criterionId === '2')).toBeDefined();
      expect(result.partialCriteriaCovered.sort()).toEqual(['1', '2', '3']);
      expect(result.partialCriteriaFailed).toEqual([]);
      const cappedOutput = result.workerOutputs.find(o => o.criterionId === '2');
      expect(cappedOutput).toBeDefined();
      expect(cappedOutput!.narrative).toMatch(/^## Finding 1: \[N\/A\]/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits per-sub-worker observability events through the bus', async () => {
    const events: any[] = [];
    const bus = {
      on: vi.fn(),
      emit: (e: any) => events.push(e),
    } as any;
    const f = makeOpenSession({
      '1': { status: 'ok', output: '## Finding 1: a' },
      '2': { status: 'ok', output: 'No findings for this criterion.' },
      '3': { status: 'ok', output: '## Finding 1: c\n## Finding 2: d' },
    });
    await dispatchParallelCriteria({
      openSession: f.openSession,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
      bus,
      route: 'audit',
    });
    const names = events.map(e => e.event);
    expect(names).toContain('criteria_fanout_start');
    expect(names.filter(n => n === 'criteria_subworker_started')).toHaveLength(3);
    expect(names.filter(n => n === 'criteria_subworker_completed')).toHaveLength(3);
    const findingsByCriterion = events
      .filter(e => e.event === 'criteria_subworker_completed')
      .reduce((m, e) => Object.assign(m, { [e.criterionId]: e.findingsCount }), {} as Record<string, number>);
    expect(findingsByCriterion['3']).toBe(2);
  });
});
