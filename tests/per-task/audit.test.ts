import { describe, it, expect, vi } from 'vitest';

const mockCreateProvider = vi.fn();

vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: (slot: string) => mockCreateProvider(slot),
}));

import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';
import { executeTask } from '../../packages/core/src/lifecycle/task-executor.js';
import { toolConfig } from '../../packages/core/src/tools/audit/tool-config.js';

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
    config: { type: 'codex' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('confirm the worker')) return mockReview;
      return mockWorker;
    },
  };
}

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'codex', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'codex', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
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

async function executeAuditFixture() {
  mockCreateProvider.mockImplementation((slot: string) => makeProvider(slot));
  const ctx = makeCtx();
  const input = { auditType: 'default' as const, filePaths: ['/tmp/spec.md'] };
  return executeTask(toolConfig, ctx, input);
}

describe('audit wallClockMs', () => {
  it('single-task audit derives wallClockMs from Date.now() (not hardcoded 0)', async () => {
    let base = 1_000_000;
    const dateMock = vi.spyOn(Date, 'now').mockImplementation(() => base++);

    const result = await executeAuditFixture();
    // wallClockMs = last_now - first_now; with base incrementing by 1 per call
    // we just verify it's strictly positive
    expect(result.wallClockMs).toBeGreaterThan(0);
    expect(result.batchTimings.wallClockMs).toBeGreaterThan(0);

    dateMock.mockRestore();
  });

  it('single-task audit wallClockMs is >= 0 under real timers', async () => {
    const result = await executeAuditFixture();
    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});
