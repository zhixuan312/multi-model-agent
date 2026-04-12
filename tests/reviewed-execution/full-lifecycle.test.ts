import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

// These tests have complex mock interactions with the review pipeline.
// The mock needs to simulate multiple provider.run() calls with different behaviors
// which is challenging with vitest's mocking system. The implementation is verified
// by the individual review module tests (spec-reviewer, quality-reviewer, etc.)
// and by integration tests in other test files.

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => {
  const impl = {
    output: '## Summary\ndone\n\n## Files changed\n- src/a.ts: updated\n\n## Normalization decisions\n\n## Validations run\n- tsc: passed\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, filesRead: ['src/a.ts'], filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
  };

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
        return impl;
      },
    }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
};

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
