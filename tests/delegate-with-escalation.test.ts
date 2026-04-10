import { describe, it, expect, vi } from 'vitest';
import { delegateWithEscalation } from '../packages/core/src/delegate-with-escalation.js';
import type {
  TaskSpec,
  RunResult,
  Provider,
  ProgressEvent,
} from '../packages/core/src/types.js';

function makeMockResult(status: RunResult['status'], output = ''): RunResult {
  return {
    output,
    status,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0 },
    turns: 5,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    escalationLog: [],
  };
}

describe('delegateWithEscalation', () => {
  it('returns immediately on first ok', async () => {
    const okProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'success')),
    };
    const expensiveProvider: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'should not be called')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [okProvider, expensiveProvider]);

    expect(result.status).toBe('ok');
    expect(result.output).toBe('success');
    expect(result.escalationLog).toHaveLength(1);
    expect(result.escalationLog[0].provider).toBe('cheap');
    expect(result.escalationLog[0].status).toBe('ok');
    expect(result.escalationLog[0].reason).toBeUndefined();
    expect(expensiveProvider.run).not.toHaveBeenCalled();
  });

  it('escalates on incomplete', async () => {
    const failingProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'partial work')),
    };
    const okProvider: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'complete answer')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
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
    const cheapFail: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'short partial')),
    };
    const expensiveFail: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi
        .fn()
        .mockResolvedValue(
          makeMockResult('incomplete', 'a much longer partial result with more useful content'),
        ),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    const result = await delegateWithEscalation(task, [cheapFail, expensiveFail]);

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('a much longer partial result with more useful content');
    expect(result.escalationLog).toHaveLength(2);
    expect(cheapFail.run).toHaveBeenCalledOnce();
    expect(expensiveFail.run).toHaveBeenCalledOnce();
  });

  it('emits escalation_start between attempts and threads onProgress into runners', async () => {
    const events: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => { events.push(e); };

    const failingProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'partial')),
    };
    const okProvider: Provider = {
      name: 'expensive',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'complete')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    await delegateWithEscalation(task, [failingProvider, okProvider], { onProgress });

    // Exactly one escalation_start event between the two attempts.
    const escalations = events.filter((e) => e.kind === 'escalation_start');
    expect(escalations).toHaveLength(1);
    const escalation = escalations[0];
    if (escalation.kind !== 'escalation_start') throw new Error('type narrow');
    expect(escalation.previousProvider).toBe('cheap');
    expect(escalation.nextProvider).toBe('expensive');
    expect(escalation.previousReason).toBe('status=incomplete');

    // Callback is threaded into both provider.run options — Tasks 9-11 will
    // emit turn/tool events through it. The orchestrator wraps `onProgress`
    // in a safeSink (try/catch) so runner throws can't corrupt dispatch, so
    // the function reference at the runner site is a wrapper, not the exact
    // callback identity — match any function.
    expect(failingProvider.run).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(okProvider.run).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('does not emit escalation_start when the first attempt succeeds', async () => {
    const events: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent) => { events.push(e); };

    const okProvider: Provider = {
      name: 'cheap',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('ok', 'success')),
    };

    const task: TaskSpec = { prompt: 'test', tier: 'standard', requiredCapabilities: [] };
    await delegateWithEscalation(task, [okProvider], { onProgress });

    expect(events.filter((e) => e.kind === 'escalation_start')).toHaveLength(0);
  });

  it('honors explicit pin: does not escalate when task.provider is set', async () => {
    const failingProvider: Provider = {
      name: 'pinned',
      config: { type: 'codex', model: 'gpt-5-codex' },
      run: vi.fn().mockResolvedValue(makeMockResult('incomplete', 'partial')),
    };

    const task: TaskSpec = {
      prompt: 'test',
      tier: 'standard',
      requiredCapabilities: [],
      provider: 'pinned',
    };
    const result = await delegateWithEscalation(task, [failingProvider], {
      explicitlyPinned: true,
    });

    expect(result.status).toBe('incomplete');
    expect(result.output).toBe('partial');
    expect(result.escalationLog).toHaveLength(1);
    expect(result.escalationLog[0].provider).toBe('pinned');
  });
});
