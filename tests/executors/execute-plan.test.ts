import { describe, it, expect, vi } from 'vitest';

const mockCreateProvider = vi.fn();

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => mockCreateProvider(slot),
}));

import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';
import { executeExecutePlan } from '../../packages/core/src/lifecycle/executors/execute-plan.js';

const mockWorker: RunResult = {
  output: 'Task completed: modified src/foo.ts',
  status: 'ok',
  usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUSD: 0.02 },
  turns: 2,
  filesRead: ['src/foo.ts'],
  filesWritten: ['src/foo.ts'],
  toolCalls: ['readFile(src/foo.ts)', 'writeFile(src/foo.ts)'],
  outputIsDiagnostic: false,
  escalationLog: [],
  retryable: false,
  durationMs: 2000,
} as RunResult;

function makeProvider(slot: string) {
  return {
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async () => mockWorker,
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

async function executeExecutePlanSingleTaskFixture() {
  mockCreateProvider.mockImplementation((slot: string) => makeProvider(slot));
  const ctx = makeCtx();
  const input = {
    filePaths: ['/tmp/nonexistent-plan.md'],
    tasks: ['Task A1: do something'],
  };
  return executeExecutePlan(ctx, input);
}

describe('executePlan wallClockMs', () => {
  it('emits non-zero wallClockMs derived from Date.now() (no hardcoded zero)', async () => {
    let callCount = 0;
    const dateMock = vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 1_000_000 : 1_005_000;
    });

    const result = await executeExecutePlanSingleTaskFixture();
    // executeExecutePlan can return a validation error or output
    if ('isError' in result) {
      // Should not happen with valid input
      expect.unreachable(`unexpected validation error: ${result.error}`);
    }
    expect(result.wallClockMs).toBe(5000);
    expect(result.batchTimings.wallClockMs).toBe(5000);

    dateMock.mockRestore();
  });

  it('wallClockMs is >= 0 under real timers', async () => {
    const result = await executeExecutePlanSingleTaskFixture();
    if ('isError' in result) {
      expect.unreachable(`unexpected validation error: ${result.error}`);
    }
    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});
