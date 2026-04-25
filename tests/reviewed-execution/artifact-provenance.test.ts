import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MultiModelConfig, Provider, RunResult } from '@zhixuan92/multi-model-agent-core';

type Slot = 'standard' | 'complex';
type Role = 'implement' | 'spec_review' | 'quality_review';
type Scenario = 'all_approved' | 'quality_round_cap' | 'both_unavailable_after_rework';

const calls: Array<{ slot: Slot; role: Role; prompt: string }> = [];
let scenario: Scenario = 'all_approved';
let implCount = 0;
let specReviewCount = 0;
let qualityReviewCount = 0;
let originalSetTimeout: typeof globalThis.setTimeout;

function config(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://standard.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://complex.invalid/v1' },
    },
    defaults: { timeoutMs: 600_000, maxCostUSD: 10, tools: 'full', sandboxPolicy: 'none' },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: '.token' },
      limits: {
        maxBodyBytes: 1,
        batchTtlMs: 1,
        idleProjectTimeoutMs: 1,
        clarificationTimeoutMs: 1,
        projectCap: 1,
        maxBatchCacheSize: 1,
        maxContextBlockBytes: 1,
        maxContextBlocksPerProject: 1,
        shutdownDrainMs: 1,
      },
      autoUpdateSkills: false,
    },
  };
}

function implOutput(slot: Slot, n: number): string {
  return [
    '## Summary',
    `${slot} implementation ${n} complete`,
    '',
    '## Files changed',
    '- src/a.ts: updated',
    '',
    '## Validations run',
    '- targeted check: passed',
    '',
    '## Deviations from brief',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function reviewOutput(status: 'approved' | 'changes_required', finding: string): string {
  return [
    '## Summary',
    status,
    '',
    '## Files changed',
    '',
    '## Validations run',
    '',
    '## Deviations from brief',
    status === 'changes_required' ? `- ${finding}` : '',
    '',
    '## Unresolved',
    '',
  ].join('\n');
}

function okResult(output: string): RunResult {
  return {
    output,
    status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 1,
    filesRead: ['src/a.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
    briefQualityWarnings: [],
    retryable: false,
  };
}

function apiErrorResult(slot: Slot): RunResult {
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
    error: `${slot} api down`,
  };
}

function provider(slot: Slot): Provider {
  return {
    name: slot,
    config: { type: 'openai-compatible', model: `${slot}-model`, baseUrl: `https://${slot}.invalid/v1` },
    async run(prompt: string): Promise<RunResult> {
      if (prompt.startsWith('You are a spec compliance reviewer')) {
        calls.push({ slot, role: 'spec_review', prompt });
        specReviewCount += 1;
        return okResult(reviewOutput('approved', ''));
      }

      if (prompt.startsWith('You are a code quality reviewer')) {
        calls.push({ slot, role: 'quality_review', prompt });
        qualityReviewCount += 1;
        if (scenario === 'all_approved') return okResult(reviewOutput('approved', ''));
        return okResult(reviewOutput('changes_required', `quality issue ${qualityReviewCount}`));
      }

      calls.push({ slot, role: 'implement', prompt });
      implCount += 1;
      if (scenario === 'both_unavailable_after_rework' && implCount >= 3) {
        return apiErrorResult(slot);
      }
      return okResult(implOutput(slot, implCount));
    },
  };
}

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: Slot) => provider(slot),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

beforeEach(() => {
  calls.length = 0;
  scenario = 'all_approved';
  implCount = 0;
  specReviewCount = 0;
  qualityReviewCount = 0;
  originalSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, 0, ...args)) as typeof setTimeout);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reviewed lifecycle artifact provenance', () => {
  it('records the last attempted tier as implementer when all reviews approve', async () => {
    scenario = 'all_approved';

    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts. Done when targeted check passes.', agentType: 'standard' }],
      config(),
    );

    expect(result.status).toBe('ok');
    expect(result.specReviewStatus).toBe('approved');
    expect(result.qualityReviewStatus).toBe('approved');
    expect(result.agents?.implementer).toBe('standard');
    expect(result.agents?.implementerHistory).toBeUndefined();
    expect(calls.filter((call) => call.role === 'implement').map((call) => call.slot)).toEqual(['standard']);
  });

  it('records latest attempted complex implementer when quality round cap rejects rework 2', async () => {
    scenario = 'quality_round_cap';

    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts. Done when targeted check passes.', agentType: 'standard' }],
      config(),
    );

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('round_cap');
    expect(result.qualityReviewStatus).toBe('changes_required');
    // Regression target: round-cap terminals must still include artifact provenance.
    expect(result.agents?.implementer).toBe('complex');
    expect(result.agents?.implementerHistory).toEqual(['standard', 'standard', 'complex']);
    expect(calls.filter((call) => call.role === 'implement').map((call) => call.slot)).toEqual(['standard', 'standard', 'complex']);
    expect(calls.filter((call) => call.role === 'quality_review').map((call) => call.slot)).toEqual(['complex', 'complex', 'standard']);
  });

  it('records the last successful tier when both tiers become unavailable after a prior rework', async () => {
    scenario = 'both_unavailable_after_rework';

    const [result] = await runTasks(
      [{ prompt: 'update src/a.ts. Done when targeted check passes.', agentType: 'standard' }],
      config(),
      { batchId: 'batch-artifact-provenance' },
    );

    expect(result.status).toBe('incomplete');
    expect(result.terminationReason).toBe('all_tiers_unavailable');
    expect(result.agents?.implementer).toBe('standard');
    expect(result.agents?.implementerHistory).toEqual(['standard', 'standard']);
    expect(calls.filter((call) => call.role === 'implement').map((call) => call.slot)).toEqual(['standard', 'standard', 'complex', 'standard']);
  });
});
