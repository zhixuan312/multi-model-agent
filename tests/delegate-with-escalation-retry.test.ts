import { describe, it, expect, vi } from 'vitest';
import { delegateWithEscalation } from '../packages/core/src/escalation/delegate-with-escalation.js';
import type {
  TaskSpec,
  RuntimeRunResult,
  Provider,
} from '../packages/core/src/types.js';
import type { Session, SessionOpts, TurnResult } from '../packages/core/src/types/run-result.js';

function makeTurn(
  status: RuntimeRunResult['status'],
  output = '',
  costUSD: number | null = 0,
): TurnResult {
  const terminationReason =
    status === 'ok' ? 'ok'
    : status === 'cost_exceeded' ? 'cost_exceeded'
    : status === 'timeout' ? 'time_exceeded'
    : status === 'incomplete' ? 'cap_exhausted'
    : 'error';
  return {
    output,
    usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    filesRead: [],
    filesWritten: [],
    toolCallsByName: {},
    turns: 5,
    durationMs: 0,
    costUSD,
    terminationReason: terminationReason as TurnResult['terminationReason'],
    ...(status !== 'ok' && status !== 'incomplete' && { errorCode: status }),
  };
}

/** Provider whose Session.send returns different TurnResults on successive calls. */
function sequenceProvider(turns: TurnResult[]): Provider & { sendSpy: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  const sendSpy = vi.fn().mockImplementation(() => {
    if (callIndex >= turns.length) {
      return Promise.reject(new Error('sequenceProvider: out of predefined results'));
    }
    return Promise.resolve(turns[callIndex++]);
  });
  return {
    name: 'sequence',
    config: { type: 'codex', model: 'gpt-5-codex' },
    openSession(_opts: SessionOpts): Session {
      return {
        send: sendSpy,
        close: async () => undefined,
      };
    },
    sendSpy,
  };
}

describe('delegateWithEscalation retry', () => {
  it('retries api_error and succeeds on 2nd attempt', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'error 1'),
      makeTurn('ok', 'success'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(provider.sendSpy).toHaveBeenCalledTimes(2);
  });

  it('retries provider_transport_failure up to 2 times (3 total attempts)', async () => {
    const provider = sequenceProvider([
      makeTurn('provider_transport_failure' as RuntimeRunResult['status'], 'net fail 1'),
      makeTurn('provider_transport_failure' as RuntimeRunResult['status'], 'net fail 2'),
      makeTurn('ok', 'success'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(provider.sendSpy).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_RETRIES for persistent api_error', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'fail 1'),
      makeTurn('api_error', 'fail 2'),
      makeTurn('api_error', 'fail 3'),
      makeTurn('api_error', 'fail 4'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('api_error');
    expect(provider.sendSpy).toHaveBeenCalledTimes(3);
  });

  it('retries timeout only once', async () => {
    const provider = sequenceProvider([
      makeTurn('timeout' as RuntimeRunResult['status'], 'slow 1'),
      makeTurn('ok', 'success'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('ok');
    expect(provider.sendSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry incomplete', async () => {
    const provider = sequenceProvider([
      makeTurn('incomplete', 'partial'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('incomplete');
    expect(provider.sendSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry cost_exceeded', async () => {
    const provider = sequenceProvider([
      makeTurn('cost_exceeded', 'cap hit'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.status).toBe('cost_exceeded');
    expect(provider.sendSpy).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when task-level cost cap is hit between attempts', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'err 1', 0.6),
      makeTurn('api_error', 'err 2', 0.5),
    ]);
    const task: TaskSpec = { prompt: 'test', maxCostUSD: 1.0 };
    const result = await delegateWithEscalation(task, [provider]);
    expect(result.status).toBe('api_error');
    // After attempt 1 (cost 0.6), cumulative=0.6, threshold 1.0 not yet hit, so attempt 2 fires.
    // After attempt 2 (cost 0.5), cumulative=1.1 >= 1.0, so retry breaks.
    expect(provider.sendSpy).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when external abortSignal is fired', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'fail 1'),
      makeTurn('ok', 'should not be called'),
    ]);
    const controller = new AbortController();
    const result = delegateWithEscalation(
      { prompt: 'test' },
      [provider],
      { abortSignal: controller.signal },
    );
    // Abort between attempt 1 and attempt 2.
    controller.abort();
    const r = await result;
    // The aborted retry leaves the result as the last completed attempt's status.
    expect(r.status).toBe('api_error');
    expect(provider.sendSpy.mock.calls.length).toBe(1);
  });

  it('counts retries per provider attempt, not across the chain', async () => {
    const provA = sequenceProvider([
      makeTurn('api_error', 'a1'),
      makeTurn('api_error', 'a2'),
      makeTurn('api_error', 'a3'),
    ]);
    const provB = sequenceProvider([
      makeTurn('ok', 'success'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provA, provB]);
    expect(result.status).toBe('ok');
    expect(provA.sendSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(provB.sendSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves the last result when retries exhaust without success', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'attempt 1 output'),
      makeTurn('api_error', 'attempt 2 output'),
      makeTurn('api_error', 'attempt 3 output (final)'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.output).toBe('attempt 3 output (final)');
    expect(provider.sendSpy).toHaveBeenCalledTimes(3);
  });

  it('logs each retry attempt in escalationLog', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'fail'),
      makeTurn('ok', 'success'),
    ]);
    const result = await delegateWithEscalation({ prompt: 'test' }, [provider]);
    expect(result.escalationLog.length).toBeGreaterThanOrEqual(1);
  });

  it('does not retry when task already has zero remaining timeout', async () => {
    const provider = sequenceProvider([
      makeTurn('api_error', 'attempt'),
    ]);
    const task: TaskSpec = { prompt: 'test', timeoutMs: 0 };
    const result = await delegateWithEscalation(task, [provider], {
      taskDeadlineMs: Date.now() - 1000,
    });
    expect(result.status).toBe('api_error');
    expect(provider.sendSpy).toHaveBeenCalledTimes(1);
  });

  it('skips the next provider when task-level deadline is hit', async () => {
    const provA = sequenceProvider([makeTurn('incomplete', 'partial')]);
    const provB = sequenceProvider([makeTurn('ok', 'should not be reached')]);
    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provA, provB],
      { taskDeadlineMs: Date.now() - 1000 },
    );
    expect(result.status).toBe('incomplete');
    expect(provA.sendSpy).toHaveBeenCalledTimes(1);
    expect(provB.sendSpy).not.toHaveBeenCalled();
  });
});
