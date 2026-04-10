import { describe, it, expect, vi } from 'vitest';
import { delegateWithEscalation } from '../packages/core/src/delegate-with-escalation.js';
import type { TaskSpec, RunResult, Provider } from '../packages/core/src/types.js';

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
