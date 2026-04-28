import { describe, it, expect, vi } from 'vitest';

const mockProviderRun = vi.fn();
const mockCreateProvider = vi.fn();

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => mockCreateProvider(slot),
}));

// The executor imports runTasks internally, which calls createProvider.
// We register mock implementations per test.

import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';
import { executeDebug } from '../../packages/core/src/executors/debug.js';

const workerOutput = JSON.stringify({
  findings: [
    { severity: 'high', file: 'src/bug.ts', line: 42, claim: 'null dereference on line 42', sourceQuote: 'obj.method()' },
  ],
});

const mockWorker: RunResult = {
  output: workerOutput,
  status: 'ok',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
  turns: 3,
  filesRead: ['src/bug.ts'],
  filesWritten: [],
  toolCalls: ['readFile(src/bug.ts)'],
  outputIsDiagnostic: false,
  escalationLog: [],
  briefQualityWarnings: [],
  retryable: false,
  durationMs: 1000,
} as RunResult;

const mockReview: RunResult = {
  output: JSON.stringify({ verdict: 'approved', reason: 'all findings grounded' }),
  status: 'ok',
  usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
  briefQualityWarnings: [],
  retryable: false,
  durationMs: 500,
} as RunResult;

function makeProvider(slot: string) {
  return {
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('confirm the worker')) return mockReview;
      return mockWorker;
    },
  };
}

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' },
};

describe('executeDebug — quality_only review', () => {
  it('returns envelope with specReviewVerdict, qualityReviewVerdict, and roundsUsed', async () => {
    mockCreateProvider.mockImplementation((slot: string) => makeProvider(slot));

    const ctx = {
      config,
      projectContext: { cwd: '/tmp/test-project' },
      contextBlockStore: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    } as any;

    const input = {
      problem: 'app crashes on startup with null pointer',
      filePaths: ['src/bug.ts'],
    };

    const result = await executeDebug(ctx, input);

    expect(result.specReviewVerdict).toBe('not_applicable');
    expect(['approved', 'concerns', 'changes_required', 'error', 'skipped', 'not_applicable']).toContain(result.qualityReviewVerdict);
    expect(typeof result.roundsUsed).toBe('number');
    expect(result.roundsUsed).toBeGreaterThanOrEqual(0);
  });
});
