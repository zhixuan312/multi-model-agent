import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';

// Mock provider so runTasks can create providers for all tiers.
vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) {
        return reviewResult;
      }
      if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) {
        return reviewResult;
      }
      return implResult;
    },
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

vi.mock('@zhixuan92/multi-model-agent-core/review/evidence', () => ({
  buildEvidence: vi.fn(async () => ({ block: 'diff evidence', diffTruncated: false, fullDiff: 'diff --git a/src/a.ts b/src/a.ts\n' })),
}));

const implResult = {
  output: '## Summary\ndone\n\n## Files changed\n- src/a.ts: updated\n\n## Normalization decisions\n\n## Validations run\n- npm test: passed\n\n## Deviations from brief\n\n## Unresolved\n',
  status: 'ok' as const,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
  turns: 1,
  filesRead: ['src/a.ts'],
  filesWritten: ['src/a.ts'],
  toolCalls: ['writeFile(src/a.ts)'],
  outputIsDiagnostic: false,
  escalationLog: [],
};

const reviewResult = {
  output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
  status: 'ok' as const,
  usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
};

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, maxCostUSD: 10, tools: 'full', sandboxPolicy: 'none' },
  server: {
    bind: '127.0.0.1',
    port: 0,
    auth: { tokenFile: '.token' },
    limits: { maxBodyBytes: 1, batchTtlMs: 1, idleProjectTimeoutMs: 1, clarificationTimeoutMs: 1, projectCap: 1, maxBatchCacheSize: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 },
    autoUpdateSkills: false,
  },
};

import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/run-tasks';

describe('quality_review stage guard', () => {
  it.each([
    ['diff_only', false],
    ['none', false],
    ['full', true],
  ] as const)('reviewPolicy=%s → quality_review.entered=%s', async (policy, expected) => {
    const [result] = await runTasks(
      [{ prompt: 'edit src/a.ts', agentType: 'standard', reviewPolicy: policy }],
      config,
    );

    expect(result.stageStats).toBeDefined();
    expect(result.stageStats!.quality_review.entered).toBe(expected);
  });

  it('reviewPolicy=quality_only → quality_review.entered=true (requires read-only route)', async () => {
    const [result] = await runTasks(
      [{ prompt: 'audit this code', agentType: 'standard', reviewPolicy: 'quality_only' }],
      config,
      { route: 'audit' },
    );

    expect(result.stageStats).toBeDefined();
    expect(result.stageStats!.quality_review.entered).toBe(true);
    expect(result.stageStats!.spec_review.entered).toBe(false);
  });
});
