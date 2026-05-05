import { describe, it, expect, vi } from 'vitest';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

let specReviewVerdict: 'approved' | 'changes_required' = 'approved';
let qualityReviewVerdict: 'approved' | 'changes_required' = 'approved';
let reworkImplFails = false;
let initialImplFails = false;
let implCallCount = 0;

const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 };

function implOutput(): string {
  return [
    '## Summary', 'implementation complete', '',
    '## Files changed', '- src/a.ts: updated', '',
    '## Normalization decisions', '',
    '## Validations run', '- npm test: passed', '',
    '## Deviations from brief', '',
    '## Unresolved', '',
  ].join('\n');
}

function reviewOutput(status: string): string {
  return ['## Summary', status, '', '## Deviations from brief', '', '## Unresolved', ''].join('\n');
}

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (_slot: string) => ({
    name: _slot,
    config: { type: 'openai-compatible' as const, model: `${_slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      if (initialImplFails) {
        return {
          output: 'timeout',
          status: 'timeout' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
          outputIsDiagnostic: true, escalationLog: [], durationMs: 0,
          directoriesListed: [], workerStatus: 'failed' as const,
          terminationReason: {
            cause: 'timeout' as const, turnsUsed: 0, hasFileArtifacts: false,
            usedShell: false, workerSelfAssessment: null, wasPromoted: false,
          },
        };
      }
      if (typeof prompt === 'string' && prompt.includes('spec compliance reviewer')) {
        return {
          output: reviewOutput(specReviewVerdict),
          status: 'ok' as const, usage, turns: 1,
          filesRead: [], filesWritten: [], toolCalls: [],
          outputIsDiagnostic: false, escalationLog: [], durationMs: 0,
          directoriesListed: [],
          workerStatus: 'done' as const,
          specReviewStatus: specReviewVerdict as 'approved' | 'changes_required',
          terminationReason: {
            cause: 'finished' as const, turnsUsed: 1, hasFileArtifacts: false,
            usedShell: false, workerSelfAssessment: 'done', wasPromoted: false,
          },
        };
      }
      if (typeof prompt === 'string' && prompt.includes('code quality reviewer')) {
        return {
          output: reviewOutput(qualityReviewVerdict),
          status: 'ok' as const, usage, turns: 1,
          filesRead: [], filesWritten: [], toolCalls: [],
          outputIsDiagnostic: false, escalationLog: [], durationMs: 0,
          directoriesListed: [],
          workerStatus: 'done' as const,
          qualityReviewStatus: qualityReviewVerdict as 'approved' | 'changes_required',
          terminationReason: {
            cause: 'finished' as const, turnsUsed: 1, hasFileArtifacts: false,
            usedShell: false, workerSelfAssessment: 'done', wasPromoted: false,
          },
        };
      }
      implCallCount++;
      if (reworkImplFails && implCallCount >= 2) {
        return {
          output: 'timeout mid-loop',
          status: 'timeout' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
          turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
          outputIsDiagnostic: true, escalationLog: [], durationMs: 0,
          directoriesListed: [], workerStatus: 'failed' as const,
          terminationReason: {
            cause: 'timeout' as const, turnsUsed: 0, hasFileArtifacts: false,
            usedShell: false, workerSelfAssessment: null, wasPromoted: false,
          },
        };
      }
      return {
        output: implOutput(),
        status: 'ok' as const, usage, turns: 1,
        filesRead: [], filesWritten: ['src/a.ts'],
        toolCalls: ['writeFile(src/a.ts)'],
        outputIsDiagnostic: false, escalationLog: [], durationMs: 0,
        directoriesListed: [],
        workerStatus: 'done' as const,
        terminationReason: {
          cause: 'finished' as const, turnsUsed: 1, hasFileArtifacts: true,
          usedShell: false, workerSelfAssessment: 'done', wasPromoted: false,
        },
      };
    },
  }),
}));

vi.mock('@zhixuan92/multi-model-agent-core/lifecycle/handlers/verify-stage', () => ({
  runVerifyStage: vi.fn(async () => ({
    status: 'skipped' as const, steps: [], totalDurationMs: 0,
    skipReason: 'no_command' as const,
  })),
}));

vi.mock('@zhixuan92/multi-model-agent-core/review/evidence', () => ({
  buildEvidence: vi.fn(async () => ({
    block: 'diff evidence', diffTruncated: false,
    fullDiff: 'diff --git a/src/a.ts b/src/a.ts\n',
  })),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, maxCostUSD: 10, tools: 'full', sandboxPolicy: 'none' },
  server: {
    bind: '127.0.0.1', port: 0, auth: { tokenFile: '.token' },
    limits: {
      maxBodyBytes: 1, batchTtlMs: 1, idleProjectTimeoutMs: 1,
      clarificationTimeoutMs: 1, projectCap: 1, maxBatchCacheSize: 1,
      maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1,
    },
    autoUpdateSkills: false,
  },
};

import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/run-tasks';

function reset() {
  specReviewVerdict = 'approved';
  qualityReviewVerdict = 'approved';
  reworkImplFails = false;
  initialImplFails = false;
  implCallCount = 0;
}

describe('review stage finalizer (Item 1)', () => {
  // Tests 1-2 drive bothUnavailable mid-loop, which triggers
  // delegateWithEscalation's transient retry on api_error. Each retry
  // chain takes ~3s (BASE_DELAY_MS=1000, exponential backoff, MAX_RETRIES=2).
  // Two tiers × 3s ≈ 6s, so give these tests 15s.

  it('records spec_review even when spec_rework hits bothUnavailable mid-iteration', async () => {
    reset();
    specReviewVerdict = 'changes_required';
    reworkImplFails = true;
    const [r] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', reviewPolicy: 'full' }], config);

    expect(r.stageStats.spec_review.entered).toBe(true);
    expect(r.stageStats.spec_review.verdict).toBe('changes_required');
    expect(r.stageStats.spec_rework.entered).toBe(true);
  }, 10_000);

  it('records quality_review even when quality_rework hits bothUnavailable mid-iteration', async () => {
    reset();
    qualityReviewVerdict = 'changes_required';
    reworkImplFails = true;
    const [r] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', reviewPolicy: 'full' }], config);

    expect(r.stageStats.spec_review.entered).toBe(true);
    expect(r.stageStats.quality_review.entered).toBe(true);
    expect(r.stageStats.quality_review.verdict).toBe('changes_required');
    expect(r.stageStats.quality_rework.entered).toBe(true);
  }, 10_000);

  it('does NOT fabricate spec_review when stage was never started (initial-impl-bothUnavailable)', async () => {
    reset();
    initialImplFails = true;
    const [r] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', reviewPolicy: 'full' }], config);

    expect(r.stageStats.spec_review.entered).toBe(false);
    expect(r.stageStats.quality_review.entered).toBe(false);
  }, 15_000);

  it('idempotent: finalizer records correct stage stats on a normal full-review run', async () => {
    reset();
    const [r] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', reviewPolicy: 'full' }], config);

    expect(r.stageStats.spec_review.entered).toBe(true);
    expect(r.stageStats.spec_review.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.stageStats.spec_review.durationMs).toBeLessThan(60_000);
    expect(r.stageStats.quality_review.entered).toBe(true);
    expect(r.stageStats.quality_review.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.stageStats.quality_review.durationMs).toBeLessThan(60_000);
  });
});
