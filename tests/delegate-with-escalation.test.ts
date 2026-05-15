import { describe, it, expect, vi } from 'vitest';
import { delegateWithEscalation } from '../packages/core/src/escalation/delegate-with-escalation.js';
import type {
  TaskSpec,
  RunResult,
  Provider,
} from '../packages/core/src/types.js';
import type { InternalRunnerEvent } from '../packages/core/src/providers/runner-types.js';
import type { Session, SessionOpts, TurnResult } from '../packages/core/src/types/run-result.js';

interface MockTurn {
  status: RunResult['status'];
  output?: string;
  outputIsDiagnostic?: boolean;
  workerSelfAssessment?: TurnResult['workerSelfAssessment'];
  filesWritten?: string[];
  toolCallsByName?: Record<string, number>;
  error?: string;
}

function buildTurn(t: MockTurn): TurnResult {
  const terminationReason: TurnResult['terminationReason'] =
    t.status === 'ok' ? 'ok'
    : t.status === 'cost_exceeded' ? 'cost_exceeded'
    : t.status === 'timeout' ? 'time_exceeded'
    : t.status === 'incomplete' ? 'cap_exhausted'
    : 'error';
  return {
    output: t.output ?? '',
    usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [],
    filesWritten: t.filesWritten ?? [],
    toolCallsByName: t.toolCallsByName ?? {},
    turns: 5,
    durationMs: 0,
    costUSD: 0,
    terminationReason,
    ...(t.error && { errorMessage: t.error }),
    ...(t.status !== 'ok' && t.status !== 'incomplete' && t.status !== 'cost_exceeded' && t.status !== 'timeout' && { errorCode: t.status }),
    ...(t.workerSelfAssessment && { workerSelfAssessment: t.workerSelfAssessment }),
  };
}

function makeProvider(name: string, turn: MockTurn): Provider & { sendSpy: ReturnType<typeof vi.fn> } {
  const sendSpy = vi.fn().mockResolvedValue(buildTurn(turn));
  return {
    name,
    config: { type: 'codex', model: 'gpt-5-codex' },
    openSession(_opts: SessionOpts): Session {
      return { send: sendSpy, close: async () => undefined };
    },
    sendSpy,
  };
}

describe('delegateWithEscalation', () => {
  it('returns immediately on first ok', async () => {
    const okProvider = makeProvider('cheap', { status: 'ok', output: 'success' });
    const expensiveProvider = makeProvider('expensive', { status: 'ok', output: 'should not be called' });

    const task: TaskSpec = { prompt: 'test' };
    const result = await delegateWithEscalation(task, [okProvider, expensiveProvider]);

    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(result.escalationLog).toHaveLength(1);
    expect(result.escalationLog[0].provider).toBe('cheap');
    expect(result.escalationLog[0].status).toBe('ok');
    expect(result.escalationLog[0].reason).toBeUndefined();
    expect(expensiveProvider.sendSpy).not.toHaveBeenCalled();
  });

  it('escalates on incomplete', async () => {
    const failingProvider = makeProvider('cheap', { status: 'incomplete', output: 'partial work' });
    const okProvider = makeProvider('expensive', { status: 'ok', output: 'complete answer' });

    const task: TaskSpec = { prompt: 'test' };
    const result = await delegateWithEscalation(task, [failingProvider, okProvider]);

    expect(result.status).toBe('ok');
    expect(result.output).toBe('complete answer');
    expect(result.escalationLog).toHaveLength(2);
    expect(result.escalationLog[0].provider).toBe('cheap');
    expect(result.escalationLog[0].status).toBe('incomplete');
    expect(result.escalationLog[0].reason).toBe('status=incomplete');
    expect(result.escalationLog[1].provider).toBe('expensive');
    expect(result.escalationLog[1].status).toBe('ok');
  });

  it('returns the best salvageable output when all providers fail', async () => {
    const cheapFail = makeProvider('cheap', { status: 'incomplete', output: 'short partial' });
    const expensiveFail = makeProvider('expensive', {
      status: 'incomplete',
      output: 'a much longer partial result with more useful content',
    });

    const task: TaskSpec = { prompt: 'test' };
    const result = await delegateWithEscalation(task, [cheapFail, expensiveFail]);

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('a much longer partial result with more useful content');
    expect(result.escalationLog).toHaveLength(2);
    expect(cheapFail.sendSpy).toHaveBeenCalledOnce();
    expect(expensiveFail.sendSpy).toHaveBeenCalledOnce();
  });

  it('emits escalation_start between attempts', async () => {
    const events: InternalRunnerEvent[] = [];
    const onProgress = (e: InternalRunnerEvent) => { events.push(e); };

    const failingProvider = makeProvider('cheap', { status: 'incomplete', output: 'partial' });
    const okProvider = makeProvider('expensive', { status: 'ok', output: 'complete' });

    const task: TaskSpec = { prompt: 'test' };
    await delegateWithEscalation(task, [failingProvider, okProvider], { onProgress });

    const escalations = events.filter((e) => e.kind === 'escalation_start');
    expect(escalations).toHaveLength(1);
    const escalation = escalations[0];
    if (escalation.kind !== 'escalation_start') throw new Error('type narrow');
    expect(escalation.previousProvider).toBe('cheap');
    expect(escalation.nextProvider).toBe('expensive');
    expect(escalation.previousReason).toBe('status=incomplete');
  });

  it('does not emit escalation_start when the first attempt succeeds', async () => {
    const events: InternalRunnerEvent[] = [];
    const onProgress = (e: InternalRunnerEvent) => { events.push(e); };

    const okProvider = makeProvider('cheap', { status: 'ok', output: 'success' });

    const task: TaskSpec = { prompt: 'test' };
    await delegateWithEscalation(task, [okProvider], { onProgress });

    expect(events.filter((e) => e.kind === 'escalation_start')).toHaveLength(0);
  });

  it('honors explicit pin: does not escalate when task.provider is set', async () => {
    const failingProvider = makeProvider('pinned', { status: 'incomplete', output: 'partial' });

    const task: TaskSpec = { prompt: 'test' };
    const result = await delegateWithEscalation(task, [failingProvider], { explicitlyPinned: true });

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('partial');
    expect(result.escalationLog).toHaveLength(1);
    expect(result.escalationLog[0].provider).toBe('pinned');
  });

  it('sets terminationReason.cause=finished on success early-return', async () => {
    const provider = makeProvider('test-provider', {
      status: 'ok',
      output: 'done',
      filesWritten: ['x.ts'],
      toolCallsByName: { runShell: 1 },
      workerSelfAssessment: 'done',
    });
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('ok');
    expect(result.terminationReason).toEqual(expect.objectContaining({
      cause: 'finished',
      hasFileArtifacts: true,
    }));
  });

  describe('status flow (v5 — annotate is single point of truth)', () => {
    it('preserves incomplete status; does NOT promote based on workerSelfAssessment', async () => {
      const provider = makeProvider('standard', {
        status: 'incomplete',
        output: 'Everything looks fine.',
        filesWritten: [],
        toolCallsByName: { readFile: 1 },
        workerSelfAssessment: 'done',
      });

      const task: TaskSpec = { prompt: 'Verify everything works' };
      const result = await delegateWithEscalation(task, [provider]);

      // v5: escalation flows the status through unchanged. Annotate decides
      // completed (spec §9 M1 fix). The result here is whatever the worker
      // reported; the wasPromoted flag is always false because escalation
      // no longer promotes.
      expect(result.status).toBe('incomplete');
      expect(result.terminationReason?.wasPromoted).toBe(false);
    });

    it('records truthful workerSelfAssessment in terminationReason (M3 fix)', async () => {
      const provider = makeProvider('standard', {
        status: 'incomplete',
        output: 'x',
        filesWritten: [],
        toolCallsByName: { readFile: 1 },
        workerSelfAssessment: 'failed',
      });
      const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
      expect(result.status).toBe('incomplete');
      expect(result.terminationReason?.workerSelfAssessment).toBe('failed');
    });
  });
});
