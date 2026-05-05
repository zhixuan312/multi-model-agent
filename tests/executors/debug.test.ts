import { describe, it, expect, vi } from 'vitest';

const mockCreateProvider = vi.fn();

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => mockCreateProvider(slot),
}));

import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';
import { executeDebug } from '../../packages/core/src/executors/debug.js';

const workerOutput = JSON.stringify({
  findings: [
    { severity: 'high', file: 'src/bug.ts', line: 42, hypothesis: 'null dereference', evidence: 'trace shows null at L42', fix: 'add null guard' },
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
  retryable: false,
  durationMs: 1000,
} as RunResult;

const mockReview: RunResult = {
  output: '## Summary\n\napproved',
  status: 'ok',
  usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
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

function makeCtx() {
  return {
    config,
    projectContext: { cwd: '/tmp/test-project' },
    contextBlockStore: undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
  } as any;
}

async function executeDebugFixture() {
  mockCreateProvider.mockImplementation((slot: string) => makeProvider(slot));
  const ctx = makeCtx();
  const input = { problem: 'null dereference in src/bug.ts' };
  return executeDebug(ctx, input);
}

describe('debug wallClockMs', () => {
  it('emits non-zero wallClockMs derived from Date.now() (no hardcoded zero)', async () => {
    let callCount = 0;
    const dateMock = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 1_000_000 : 1_005_000;
    });

    const result = await executeDebugFixture();
    expect(result.wallClockMs).toBe(5000);
    expect(result.batchTimings.wallClockMs).toBe(5000);

    dateMock.mockRestore();
  });

  it('wallClockMs is >= 0 under real timers', async () => {
    const result = await executeDebugFixture();
    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});
