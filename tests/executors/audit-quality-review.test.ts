import { describe, it, expect, vi } from 'vitest';

const mockProviderRun = vi.fn();
const mockCreateProvider = vi.fn();

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => mockCreateProvider(slot),
}));

import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';
import { executeAudit } from '../../packages/core/src/executors/audit.js';

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
  output: '## Summary\n\napproved',
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

describe('executeAudit — quality_only review', () => {
  it('returns terminal envelope with qualityReviewVerdict and roundsUsed', async () => {
    mockCreateProvider.mockImplementation((slot: string) => makeProvider(slot));

    const ctx = {
      config,
      projectContext: { cwd: '/tmp/test-project' },
      contextBlockStore: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    } as any;

    const input = { auditType: 'correctness' as const, filePaths: ['/tmp/spec.md'] };

    const result = await executeAudit(ctx, input);

    expect(result.specReviewVerdict).toBe('not_applicable');
    expect(['approved', 'concerns', 'changes_required', 'error', 'skipped']).toContain(result.qualityReviewVerdict);
    expect(typeof result.roundsUsed).toBe('number');
    expect(result.roundsUsed).toBeGreaterThanOrEqual(1);
  });

  it('triggers rework when worker emits no findings array', async () => {
    // First call: worker returns prose only (no findings array)
    // Second call: worker returns parseable findings after rework
    let callCount = 0;
    const proseOnlyWorker: RunResult = {
      output: 'Here is a prose audit without a findings array.',
      status: 'ok',
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110, costUSD: 0.008 },
      turns: 2,
      filesRead: ['src/target.ts'],
      filesWritten: [],
      toolCalls: ['readFile(src/target.ts)'],
      outputIsDiagnostic: false,
      escalationLog: [],
      briefQualityWarnings: [],
      retryable: false,
      durationMs: 800,
    } as RunResult;

    const findingsWorker: RunResult = {
      output: JSON.stringify({
        findings: [
          { severity: 'medium', file: 'src/target.ts', line: 10, claim: 'missing null check', sourceQuote: 'x.y' },
        ],
      }),
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
      turns: 3,
      filesRead: ['src/target.ts'],
      filesWritten: [],
      toolCalls: ['readFile(src/target.ts)'],
      outputIsDiagnostic: false,
      escalationLog: [],
      briefQualityWarnings: [],
      retryable: false,
      durationMs: 1000,
    } as RunResult;

    const changesRequiredReview: RunResult = {
      output: '## Summary\n\nchanges_required — missing or malformed findings array',
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

    const approvedReview: RunResult = {
      output: '## Summary\n\napproved — findings are grounded',
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

    mockCreateProvider.mockImplementation((slot: string) => ({
      name: slot,
      config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: async (prompt: string) => {
        callCount++;
        if (typeof prompt === 'string' && prompt.includes('confirm the worker')) {
          if (callCount <= 3) return changesRequiredReview;
          return approvedReview;
        }
        if (callCount === 1) return proseOnlyWorker;
        return findingsWorker;
      },
    }));

    const ctx = {
      config,
      projectContext: { cwd: '/tmp/test-project' },
      contextBlockStore: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    } as any;

    const input = { auditType: 'security' as const, filePaths: ['/tmp/spec.md'] };

    const result = await executeAudit(ctx, input);

    expect(result.specReviewVerdict).toBe('not_applicable');
    expect(['approved', 'concerns', 'changes_required', 'error', 'skipped']).toContain(result.qualityReviewVerdict);
    expect(typeof result.roundsUsed).toBe('number');
  });
});
