import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001 };
const providerCalls: Array<{ slot: 'standard' | 'complex'; kind: 'implementer' | 'specReviewer' }> = [];

function implementationResult(slot: 'standard' | 'complex'): RunResult {
  return {
    output: [
      '## Summary',
      `${slot} implementation complete`,
      '',
      '## Files changed',
      '- src/a.ts: updated',
      '',
      '## Normalization decisions',
      '',
      '## Validations run',
      '- npm test: passed',
      '',
      '## Deviations from brief',
      '',
      '## Unresolved',
      '',
    ].join('\n'),
    status: 'ok',
    usage,
    turns: 1,
    filesRead: ['src/a.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
  };
}

function reviewerDownResult(slot: 'standard' | 'complex'): RunResult {
  return {
    output: '',
    status: 'api_error',
    usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, costUSD: 0 },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: true,
    escalationLog: [],
    error: `${slot} reviewer api down`,
  };
}

function mockProvider(slot: 'standard' | 'complex'): Provider {
  return {
    name: slot,
    config: { type: 'openai-compatible', model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    async run(): Promise<RunResult> {
      providerCalls.push({ slot, kind: 'implementer' });
      return implementationResult(slot);
    },
  };
}

vi.mock('@zhixuan92/multi-model-agent-core/providers/provider-factory', () => ({
  createProvider: (slot: 'standard' | 'complex') => mockProvider(slot),
}));

vi.mock('@zhixuan92/multi-model-agent-core/review/spec-reviewer', () => ({
  runSpecReview: vi.fn(async (provider: Provider) => {
    const slot = provider.name as 'standard' | 'complex';
    providerCalls.push({ slot, kind: 'specReviewer' });
    return { status: 'api_error' as const, findings: [], errorReason: `${slot} reviewer api down` };
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/run-tasks';

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

describe('reviewed lifecycle fallback when both spec reviewer tiers are down', () => {
  it('skips spec review without aborting the lifecycle', async () => {
    providerCalls.length = 0;
    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts to satisfy the spec', agentType: 'standard', reviewPolicy: 'full' }],
      config,
      { batchId: 'batch-reviewer-both-down' },
    );

    expect(providerCalls).toEqual([
      { slot: 'standard', kind: 'implementer' },
      { slot: 'complex', kind: 'specReviewer' },
    ]);

    // 3.12.3: when both reviewer tiers are down (complex transport-failed,
    // standard forbidden by slot separation), the lifecycle terminates as
    // incomplete with errorCode=reviewer_separation_unsatisfiable. Pre-3.12.3
    // identity-based skip produced a softer 'not_configured' reason that
    // caused the lifecycle to soft-skip and continue — that path is gone now
    // that reviewer separation is purely slot-based.
    expect(result.status).toBe('incomplete');
    expect(result.errorCode).toBe('reviewer_separation_unsatisfiable');
    expect(result.agents?.specReviewerHistory).toContain('skipped');
  });
});
