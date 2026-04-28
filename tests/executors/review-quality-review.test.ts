import { describe, expect, it, vi } from 'vitest';
import { executeReview } from '../../packages/core/src/executors/review.js';
import type { MultiModelConfig } from '../../packages/core/src/types.js';

const workerResult = {
  output: JSON.stringify({
    findings: [
      { id: 'F1', severity: 'high' as const, file: 'src/a.ts', line: 10, claim: 'Missing null check' },
    ],
  }),
  status: 'ok' as const,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
  turns: 1,
  filesRead: ['src/a.ts'],
  filesWritten: ['review_output.md'],
  toolCalls: ['readFile(src/a.ts)'],
  outputIsDiagnostic: false,
  escalationLog: [],
  durationMs: 100,
  directoriesListed: [],
  terminationReason: {
    cause: 'finished' as const,
    turnsUsed: 1,
    hasFileArtifacts: false,
    usedShell: false,
    workerSelfAssessment: 'done' as const,
    wasPromoted: false,
  },
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
  durationMs: 50,
  directoriesListed: [],
  terminationReason: {
    cause: 'finished' as const,
    turnsUsed: 1,
    hasFileArtifacts: false,
    usedShell: false,
    workerSelfAssessment: 'done' as const,
    wasPromoted: false,
  },
};

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      // Quality reviewer gets the custom prompt built by buildReviewQualityPrompt
      if (typeof prompt === 'string' && prompt.includes('findings[]')) {
        return reviewResult;
      }
      return workerResult;
    },
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content'),
}));

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

describe('executeReview — quality_only review', () => {
  it('returns terminal envelope with qualityReviewVerdict and roundsUsed', async () => {
    const ctx = {
      config,
      projectContext: { cwd: '/tmp/test' },
      logger: {} as any,
      contextBlockStore: undefined,
    } as any;

    const input = { code: 'const x = 1;' };
    const result = await executeReview(ctx, input);

    expect(result.specReviewVerdict).toBe('not_applicable');
    expect(['approved', 'concerns', 'changes_required', 'error', 'skipped']).toContain(result.qualityReviewVerdict);
    expect(typeof result.roundsUsed).toBe('number');
    expect(result.roundsUsed).toBeGreaterThanOrEqual(1);
  });
});
