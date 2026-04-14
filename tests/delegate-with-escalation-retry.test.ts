import { describe, it, expect, vi } from 'vitest';
import { delegateWithEscalation } from '../packages/core/src/delegate-with-escalation.js';
import type {
  TaskSpec,
  RunResult,
  Provider,
  ProgressEvent,
} from '../packages/core/src/types.js';

function makeMockResult(
  status: RunResult['status'],
  output = '',
  costUSD = 0,
): RunResult {
  return {
    output,
    status,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD },
    turns: 5,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
  };
}

/** Helper: returns different results on successive calls. */
function sequenceProvider(results: RunResult[]): Provider {
  let callIndex = 0;
  return {
    name: 'sequence',
    config: { type: 'codex', model: 'gpt-5-codex' },
    run: vi.fn().mockImplementation(() => {
      if (callIndex >= results.length) {
        throw new Error('sequenceProvider: out of predefined results');
      }
      return Promise.resolve(results[callIndex++]);
    }),
  };
}

describe('delegateWithEscalation retry', () => {
  it('retries api_error and succeeds on 2nd attempt', async () => {
    const provider = sequenceProvider([
      makeMockResult('api_error', 'error 1'),
      makeMockResult('ok', 'success'),
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
    );

    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(provider.run).toHaveBeenCalledTimes(2);
  });

  it('retries network_error up to 2 times (3 total attempts)', async () => {
    const provider = sequenceProvider([
      makeMockResult('network_error', 'net fail 1'),
      makeMockResult('network_error', 'net fail 2'),
      makeMockResult('ok', 'success'),
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
    );

    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(provider.run).toHaveBeenCalledTimes(3);
  });

  it('gives up after MAX_RETRIES for persistent api_error', async () => {
    const provider = sequenceProvider([
      makeMockResult('api_error', 'persistent error'),
      makeMockResult('api_error', 'persistent error'),
      makeMockResult('api_error', 'persistent error'), // should not be called
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
    );

    expect(result.status).toBe('api_error');
    expect(provider.run).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries timeout only once', async () => {
    const provider = sequenceProvider([
      makeMockResult('timeout', 'timed out 1'),
      makeMockResult('ok', 'success after timeout retry'),
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
    );

    expect(result.status).toBe('ok');
    expect(provider.run).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry incomplete', async () => {
    const provider = sequenceProvider([
      makeMockResult('incomplete', 'partial'),
      makeMockResult('ok', 'success'), // should not be reached
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
    );

    expect(result.status).toBe('incomplete');
    expect(provider.run).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry cost_exceeded', async () => {
    const provider = sequenceProvider([
      makeMockResult('cost_exceeded', 'over budget'),
      makeMockResult('ok', 'success'), // should not be reached
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
    );

    expect(result.status).toBe('cost_exceeded');
    expect(provider.run).toHaveBeenCalledTimes(1);
  });

  it('emits retry progress events', async () => {
    const events: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => { events.push(e); };

    const provider = sequenceProvider([
      makeMockResult('api_error', 'fail 1'),
      makeMockResult('ok', 'success'),
    ]);

    await delegateWithEscalation(
      { prompt: 'test' },
      [provider],
      { onProgress },
    );

    const retryEvents = events.filter((e) => e.kind === 'retry');
    expect(retryEvents).toHaveLength(1);
    const event = retryEvents[0];
    if (event.kind !== 'retry') throw new Error('type narrow');
    expect(event.attempt).toBe(1);
    expect(event.previousStatus).toBe('api_error');
    expect(event.delayMs).toBe(1000); // BASE_DELAY_MS * 2^0
  });

  it('skips retry when remaining budget is zero', async () => {
    const events: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => { events.push(e); };

    const provider = sequenceProvider([
      makeMockResult('api_error', 'fail 1', 0.05),
      makeMockResult('api_error', 'fail 2', 0.05),
      makeMockResult('ok', 'success'),
    ]);

    const result = await delegateWithEscalation(
      { prompt: 'test', maxCostUSD: 0.05 },
      [provider],
      { onProgress },
    );

    // After first attempt costs 0.05, cumulative === maxCostUSD, so no retry
    expect(result.status).toBe('api_error');
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.kind === 'retry')).toHaveLength(0);
  });
});
