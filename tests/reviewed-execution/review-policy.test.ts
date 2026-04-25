import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

let verifyStatus: 'passed' | 'failed' | 'skipped' = 'passed';
let specReviewCalls = 0;
let qualityReviewCalls = 0;
let diffReviewCalls = 0;
let implementCalls = 0;

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks/verify-stage', () => ({
  runVerifyStage: vi.fn(async () => ({
    status: verifyStatus,
    steps: verifyStatus === 'skipped' ? [] : [{ command: 'npm test', status: verifyStatus, durationMs: 1 }],
    totalDurationMs: 1,
    ...(verifyStatus === 'skipped' ? { skipReason: 'no_command' } : {}),
  })),
}));

vi.mock('@zhixuan92/multi-model-agent-core/review/evidence', () => ({
  buildEvidence: vi.fn(async () => ({ block: 'diff evidence', diffTruncated: false, fullDiff: 'diff --git a/src/a.ts b/src/a.ts\n' })),
}));

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string) => {
      if (typeof prompt === 'string' && prompt.includes('You are reviewing a mechanical refactor')) {
        diffReviewCalls++;
        return { output: 'APPROVE' };
      }
      if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) {
        specReviewCalls++;
        return reviewResult;
      }
      if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) {
        qualityReviewCalls++;
        return reviewResult;
      }
      implementCalls++;
      return implResult;
    },
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

const implResult = {
  output: '## Summary\ndone\n\n## Files changed\n- src/a.ts: updated\n\n## Normalization decisions\n\n## Validations run\n- npm test: passed\n\n## Deviations from brief\n\n## Unresolved\n',
  status: 'ok' as const,
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
  turns: 1,
  filesRead: ['src/a.ts'],
  filesWritten: ['src/a.ts'],
  toolCalls: ['writeFile(src/a.ts)'],
  outputIsDiagnostic: false,
  escalationLog: [],
};

const reviewResult = {
  output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
  status: 'ok' as const,
  usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
};

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

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

function reset(status: typeof verifyStatus = 'passed') {
  verifyStatus = status;
  specReviewCalls = 0;
  qualityReviewCalls = 0;
  diffReviewCalls = 0;
  implementCalls = 0;
}

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'review-policy-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'], { cwd, stdio: 'ignore' });
  return cwd;
}

describe('reviewPolicy branching', () => {
  it('reviewPolicy=off + verification.passed → done', async () => {
    reset('passed');
    const [result] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', cwd: makeRepo(), autoCommit: true, reviewPolicy: 'off', verifyCommand: ['npm test'] }], config);

    expect(result.workerStatus).toBe('done');
    expect(result.specReviewStatus).toBe('skipped');
    expect(result.qualityReviewStatus).toBe('skipped');
    expect(result.verification?.status).toBe('passed');
  });

  it('reviewPolicy=off + verification.failed → done_with_concerns with verification concern', async () => {
    reset('failed');
    const [result] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', cwd: makeRepo(), autoCommit: true, reviewPolicy: 'off', verifyCommand: ['npm test'] }], config);

    expect(result.workerStatus).toBe('done_with_concerns');
    expect(result.concerns).toContainEqual(expect.objectContaining({ source: 'verification' }));
  });

  it('reviewPolicy=diff_only single-pass terminates without rework loop', async () => {
    reset('passed');
    const [result] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', cwd: makeRepo(), autoCommit: true, reviewPolicy: 'diff_only', verifyCommand: ['npm test'] }], config);

    expect(result.workerStatus).toBe('done');
    expect(diffReviewCalls).toBe(1);
    expect(specReviewCalls).toBe(0);
    expect(qualityReviewCalls).toBe(0);
  });

  it('reviewPolicy=spec_only skips quality_review', async () => {
    reset('passed');
    const [result] = await runTasks([{ prompt: 'edit src/a.ts', agentType: 'standard', reviewPolicy: 'spec_only' }], config);

    expect(result.specReviewStatus).toBe('approved');
    expect(result.qualityReviewStatus).toBe('skipped');
    expect(specReviewCalls).toBe(1);
    expect(qualityReviewCalls).toBe(0);
  });
});
