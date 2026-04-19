import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

let specReviewVerdict: string;
let qualityReviewVerdict: string;
let specReviewProviderStatus: 'ok' | 'timeout' = 'ok';
let qualityReviewProviderStatus: 'ok' | 'timeout' = 'ok';
let implStatus: 'ok' | 'incomplete' | 'timeout';
let implWorkerStatus: string;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => {
  const makeResult = (overrides: Record<string, unknown>) => ({
    output: '',
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 1, filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [], briefQualityWarnings: [], retryable: false,
    ...overrides,
  });

  return {
    createProvider: (slot: string) => ({
      name: slot,
      config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: async (prompt: string) => {
        if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) {
          return makeResult({
            output: `## Summary\n${specReviewVerdict}\n\n## Deviations from brief\n- finding1\n\n## Unresolved\n`,
            status: specReviewProviderStatus,
          });
        }
        if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) {
          return makeResult({
            output: `## Summary\n${qualityReviewVerdict}\n\n## Deviations from brief\n- quality-issue\n\n## Unresolved\n`,
            status: qualityReviewProviderStatus,
          });
        }
        // Implementation call
        return makeResult({
          output: `## Summary\n${implWorkerStatus}\n\n## Files changed\n- src/a.ts: updated\n\n## Validations run\n- tsc: passed\n\n## Deviations from brief\n\n## Unresolved\n`,
          status: implStatus,
          filesRead: ['src/a.ts'],
          filesWritten: ['src/a.ts'],
          toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
        });
      },
    }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' },
};

const task = {
  prompt: 'do the task at src/a.ts. Done when tsc passes.',
  agentType: 'standard' as const,
  maxReviewRounds: 1,
};

describe('status downgrade from review verdicts', () => {
  beforeEach(() => {
    specReviewVerdict = 'approved';
    qualityReviewVerdict = 'approved';
    specReviewProviderStatus = 'ok';
    qualityReviewProviderStatus = 'ok';
    implStatus = 'ok';
    implWorkerStatus = 'done';
  });

  it('test 1: spec review exhausted → status downgraded to incomplete', async () => {
    specReviewVerdict = 'changes_required';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].specReviewStatus).toBe('changes_required');
  });

  it('test 2: spec review approved → status preserved as ok', async () => {
    specReviewVerdict = 'approved';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('ok');
    expect(results[0].specReviewStatus).toBe('approved');
  });

  it('test 3: quality review exhausted → status downgraded to incomplete', async () => {
    specReviewVerdict = 'approved';
    qualityReviewVerdict = 'changes_required';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].qualityReviewStatus).toBe('changes_required');
  });

  it('test 4: review error (provider timeout) → status NOT downgraded', async () => {
    specReviewProviderStatus = 'timeout';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('ok');
    expect(results[0].specReviewStatus).toBe('error');
  });

  it('test 5: reviewPolicy=off → status NOT downgraded', async () => {
    const results = await runTasks([{ ...task, reviewPolicy: 'off' as const }], config);
    expect(results[0].status).toBe('ok');
    expect(results[0].specReviewStatus).toBe('skipped');
    expect(results[0].qualityReviewStatus).toBe('skipped');
  });

  it('test 6: non-ok status (timeout) → NOT downgraded regardless of review', async () => {
    implStatus = 'timeout';
    specReviewVerdict = 'changes_required';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('timeout');
  });

  it('test 7: promotion + downgrade compose correctly', async () => {
    implStatus = 'ok';
    implWorkerStatus = 'done';
    specReviewVerdict = 'changes_required';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
  });

  it('test 8: both reviews exhausted → status downgraded', async () => {
    specReviewVerdict = 'changes_required';
    qualityReviewVerdict = 'changes_required';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].specReviewStatus).toBe('changes_required');
    expect(results[0].qualityReviewStatus).toBe('changes_required');
  });

  it('test 9: spec error + quality changes_required → status downgraded', async () => {
    specReviewProviderStatus = 'timeout';
    qualityReviewVerdict = 'changes_required';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].specReviewStatus).toBe('error');
    expect(results[0].qualityReviewStatus).toBe('changes_required');
  });

  it('test 10: spec changes_required + quality error → status downgraded', async () => {
    specReviewVerdict = 'changes_required';
    qualityReviewProviderStatus = 'timeout';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].specReviewStatus).toBe('changes_required');
    expect(results[0].qualityReviewStatus).toBe('error');
  });

  it('test 11: spread-order regression — finalStatus overrides spread', async () => {
    specReviewVerdict = 'changes_required';
    implStatus = 'ok';
    const results = await runTasks([task], config);
    expect(results[0].status).toBe('incomplete');
    expect(results[0].structuredReport?.summary).toContain('[Spec review exhausted]');
  });
});
