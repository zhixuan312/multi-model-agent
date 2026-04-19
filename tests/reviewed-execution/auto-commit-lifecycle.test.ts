import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

let implStatus: 'ok' | 'timeout' = 'ok';

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => {
  const makeResult = (overrides: Record<string, unknown>) => ({
    output: '## Summary\nImplemented feature\n\n## Files changed\n- src/a.ts: updated\n\n## Validations run\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 1, filesRead: [], filesWritten: ['src/a.ts'], toolCalls: ['writeFile(src/a.ts)'],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
    ...overrides,
  });

  const review = {
    output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
    turns: 1, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };

  return {
    createProvider: (slot: string) => ({
      name: slot,
      config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: async (prompt: string) => {
        if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) return review;
        if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) return review;
        return makeResult({ status: implStatus });
      },
    }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock\n'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('@zhixuan92/multi-model-agent-core/auto-commit', () => ({
  autoCommitFiles: vi.fn().mockReturnValue({ sha: 'abc1234' }),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import { autoCommitFiles } from '@zhixuan92/multi-model-agent-core/auto-commit';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' },
};

describe('auto-commit in reviewed lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    implStatus = 'ok';
    (autoCommitFiles as ReturnType<typeof vi.fn>).mockReturnValue({ sha: 'abc1234' });
  });

  it('commits when autoCommit is true and worker writes files', async () => {
    const results = await runTasks(
      [{ prompt: 'do task', agentType: 'standard' as const, autoCommit: true, briefQualityPolicy: 'off' as const }],
      config,
    );
    expect(autoCommitFiles).toHaveBeenCalledWith(
      ['src/a.ts'],
      'Implemented feature',
      expect.any(String),
    );
    expect(results[0].commitSha).toBe('abc1234');
  });

  it('does not commit when autoCommit is false', async () => {
    const results = await runTasks(
      [{ prompt: 'do task', agentType: 'standard' as const, briefQualityPolicy: 'off' as const }],
      config,
    );
    expect(autoCommitFiles).not.toHaveBeenCalled();
    expect(results[0].commitSha).toBeUndefined();
  });

  it('does not commit when worker status is not ok', async () => {
    implStatus = 'timeout';
    await runTasks(
      [{ prompt: 'do task', agentType: 'standard' as const, autoCommit: true, briefQualityPolicy: 'off' as const }],
      config,
    );
    expect(autoCommitFiles).not.toHaveBeenCalled();
  });

  it('captures commit error but preserves status', async () => {
    (autoCommitFiles as ReturnType<typeof vi.fn>).mockReturnValue({ error: 'hook failed' });
    const results = await runTasks(
      [{ prompt: 'do task', agentType: 'standard' as const, autoCommit: true, briefQualityPolicy: 'off' as const }],
      config,
    );
    expect(results[0].commitError).toBe('hook failed');
    expect(results[0].status).toBe('ok');
  });
});
