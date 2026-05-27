import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { __setCoreTestProviderOverrideMap } from '@zhixuan92/multi-model-agent-core';

// Provider injection via the supported __setCoreTestProviderOverrideMap seam,
// not vi.mock('provider-factory') (sticky/process-global under Bun).
let __prevOverrideEnv: string | undefined;
beforeAll(() => {
  __prevOverrideEnv = process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
  process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
});
afterEach(() => { __setCoreTestProviderOverrideMap(null); });
afterAll(() => {
  if (__prevOverrideEnv === undefined) delete process.env.MMAGENT_TEST_PROVIDER_OVERRIDE;
  else process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = __prevOverrideEnv;
});

import type { MultiModelConfig, RuntimeRunResult, AgentType, Provider } from '@zhixuan92/multi-model-agent-core';
import { executeTask } from '../../packages/core/src/lifecycle/task-executor.js';
import { toolConfig } from '../../packages/core/src/tools/debug/tool-config.js';

const workerOutput = JSON.stringify({
  findings: [
    { severity: 'high', file: 'src/bug.ts', line: 42, claim: 'null dereference on line 42', sourceQuote: 'obj.method()' },
  ],
});

const mockWorker: RuntimeRunResult = {
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
} as RuntimeRunResult;

const mockReview: RuntimeRunResult = {
  output: JSON.stringify({ verdict: 'approved', reason: 'all findings grounded' }),
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
} as RuntimeRunResult;

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

describe('executeDebug — quality_only review', () => {
  it('returns envelope with specReviewVerdict, qualityReviewVerdict, and roundsUsed', async () => {
    __setCoreTestProviderOverrideMap(new Map<AgentType, Provider>([
      ['standard', makeProvider('standard') as unknown as Provider],
      ['complex', makeProvider('complex') as unknown as Provider],
    ]));

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

    const result = await executeTask(toolConfig, ctx, input);

    expect(result.specReviewVerdict).toBe('not_applicable');
    expect(['approved', 'concerns', 'changes_required', 'error', 'skipped', 'not_applicable', 'annotated']).toContain(result.qualityReviewVerdict);
    expect(typeof result.roundsUsed).toBe('number');
    expect(result.roundsUsed).toBeGreaterThanOrEqual(0);
  });
});
