import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

const { createProviderMock } = vi.hoisted(() => {
  const implResult: RunResult = {
    output: '## Summary\ndone\n\n## Files changed\n- src/a.ts: updated\n\n## Normalization decisions\n\n## Validations run\n- tsc: passed\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, filesRead: ['src/a.ts'], filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };

  const reviewResult: RunResult = {
    output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok',
    usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
    turns: 1, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };

  const createProviderMock = (slot: string) => {
    const mockRun = vi.fn<[string, any], Promise<RunResult>>();
    mockRun.mockImplementation(async (prompt: string) => {
      if (prompt.includes('do the task')) {
        return implResult;
      }
      return reviewResult;
    });
    return {
      name: slot,
      config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: mockRun,
    };
  };

  return { createProviderMock };
});

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: vi.fn((slot: string) => createProviderMock(slot)),
}));

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
};

beforeEach(() => vi.clearAllMocks());

describe('full reviewed lifecycle', () => {
  it('happy path: implement → spec review → quality review → aggregated result', async () => {
    const results = await runTasks(
      [{ prompt: 'do the task at src/a.ts. Done when tsc passes.', agentType: 'standard' as const }],
      config,
    );
    expect(results[0].status).toBe('ok');
    expect(results[0].structuredReport?.summary).toContain('[Reviewed]');
    expect(results[0].workerStatus).toBe('done');
    expect(results[0].specReviewStatus).toBe('approved');
    expect(results[0].qualityReviewStatus).toBe('approved');
    expect(results[0].agents?.implementer).toBe('standard');
    expect(results[0].agents?.specReviewer).toBe('complex');
    expect(results[0].agents?.qualityReviewer).toBe('complex');
  });

  it('reviewPolicy=off bypasses reviews', async () => {
    const results = await runTasks(
      [{
        prompt: 'do the task at src/a.ts. Done when tsc passes.',
        agentType: 'standard' as const,
        reviewPolicy: 'off',
      }],
      config,
    );
    expect(results[0].specReviewStatus).toBe('not_run');
    expect(results[0].qualityReviewStatus).toBe('not_run');
  });

  it('reviewPolicy=spec_only skips quality review', async () => {
    const results = await runTasks(
      [{
        prompt: 'do the task at src/a.ts. Done when tsc passes.',
        agentType: 'standard' as const,
        reviewPolicy: 'spec_only',
      }],
      config,
    );
    expect(results[0].specReviewStatus).toBe('approved');
    expect(results[0].qualityReviewStatus).toBe('not_run');
  });
});