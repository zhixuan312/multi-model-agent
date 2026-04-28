import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

// Provider state — one provider instance handles both implementer and
// reviewer roles (simplified for test determinism).
let implementerCalls = 0;
let specReviewerCalls = 0;
let qualityReviewerCalls = 0;
let diffReviewerCalls = 0;
let reviewerShouldHang = false;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string, opts?: { abortSignal?: AbortSignal; timeoutMs?: number }): Promise<RunResult> => {
      if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) {
        specReviewerCalls++;
        if (reviewerShouldHang) {
          // Hang until the stall watchdog fires and aborts.
          if (opts?.abortSignal?.aborted) {
            return {
              output: 'review aborted before start',
              status: 'api_aborted',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
              turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
              outputIsDiagnostic: true, escalationLog: [], durationMs: 0,
              directoriesListed: [],
            };
          }
          return new Promise((resolve) => {
            const onAbort = (): void => {
              resolve({
                output: 'review aborted by watchdog',
                status: 'api_aborted',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
                turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
                outputIsDiagnostic: true, escalationLog: [], durationMs: 0,
                directoriesListed: [],
              });
            };
            opts?.abortSignal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        return reviewResult;
      }
      if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) {
        qualityReviewerCalls++;
        if (reviewerShouldHang) {
          if (opts?.abortSignal?.aborted) {
            return {
              output: 'review aborted before start',
              status: 'api_aborted',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
              turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
              outputIsDiagnostic: true, escalationLog: [], durationMs: 0,
              directoriesListed: [],
            };
          }
          return new Promise((resolve) => {
            const onAbort = (): void => {
              resolve({
                output: 'review aborted by watchdog',
                status: 'api_aborted',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
                turns: 0, filesRead: [], filesWritten: [], toolCalls: [],
                outputIsDiagnostic: true, escalationLog: [], durationMs: 0,
                directoriesListed: [],
              });
            };
            opts?.abortSignal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        return reviewResult;
      }
      if (typeof prompt === 'string' && prompt.includes('You are reviewing a mechanical refactor')) {
        diffReviewerCalls++;
        return { output: 'APPROVE' as any, status: 'ok' as const };
      }
      implementerCalls++;
      return implResult;
    },
  }),
}));

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks/verify-stage', () => ({
  runVerifyStage: vi.fn(async () => ({
    status: 'passed' as const,
    steps: [{ command: 'true', status: 'passed' as const, durationMs: 1 }],
    totalDurationMs: 1,
  })),
}));

vi.mock('@zhixuan92/multi-model-agent-core/review/evidence', () => ({
  buildEvidence: vi.fn(async () => ({
    block: 'diff evidence',
    diffTruncated: false,
    fullDiff: 'diff --git a/src/a.ts b/src/a.ts\n+// new code\n',
  })),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

const implResult: RunResult = {
  output:
    '## Summary\ndone\n\n' +
    '## Files changed\n- src/a.ts: updated\n\n' +
    '## Normalization decisions\n\n' +
    '## Validations run\n- tsc: passed\n\n' +
    '## Deviations from brief\n\n' +
    '## Unresolved\n',
  status: 'ok',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
  turns: 3,
  filesRead: ['src/a.ts'],
  filesWritten: ['src/a.ts'],
  toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
  outputIsDiagnostic: false,
  escalationLog: [],
  durationMs: 0,
  directoriesListed: [],
  terminationReason: {
    cause: 'finished',
    turnsUsed: 3,
    hasFileArtifacts: true,
    usedShell: false,
    workerSelfAssessment: 'done',
    wasPromoted: false,
  },
};

const reviewResult: RunResult = {
  output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
  status: 'ok',
  usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
  turns: 1,
  filesRead: [],
  filesWritten: [],
  toolCalls: [],
  outputIsDiagnostic: false,
  escalationLog: [],
  durationMs: 0,
  directoriesListed: [],
  terminationReason: {
    cause: 'finished',
    turnsUsed: 1,
    hasFileArtifacts: false,
    usedShell: false,
    workerSelfAssessment: 'done',
    wasPromoted: false,
  },
};

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-stall-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'], {
    cwd,
    stdio: 'ignore',
  });
  return cwd;
}

function makeConfig(
  overrides: { stallTimeoutMs?: number; timeoutMs?: number } = {},
): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: {
      timeoutMs: overrides.timeoutMs ?? 300_000,
      stallTimeoutMs: overrides.stallTimeoutMs ?? 600_000,
      maxCostUSD: 10,
      tools: 'full',
      sandboxPolicy: 'none',
    },
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

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

function reset(hang: boolean = false) {
  implementerCalls = 0;
  specReviewerCalls = 0;
  qualityReviewerCalls = 0;
  diffReviewerCalls = 0;
  reviewerShouldHang = hang;
}

describe('reviewer stall watchdog', () => {
  it(
    'aborts a hung spec reviewer + returns stallTriggered=true',
    async () => {
      reset(true); // reviewer hangs
      // stallTimeoutMs = 500ms — very small so the watchdog fires quickly.
      // The watchdog poll interval is hardcoded at 5s, so the test takes
      // ~5s real time (acceptable for an integration test).
      const config = makeConfig({ stallTimeoutMs: 500, timeoutMs: 300_000 });
      const cwd = makeRepo();

      const results = await runTasks(
        [
          {
            prompt: 'edit src/a.ts. Done when tsc passes.',
            agentType: 'standard' as const,
            cwd,
            reviewPolicy: 'spec_only',
          } as any,
        ],
        config,
      );

      expect(results).toHaveLength(1);
      const r = results[0];

      // The spec reviewer was called and then aborted by the watchdog
      expect(specReviewerCalls).toBeGreaterThanOrEqual(1);

      // stallTriggered must be true — the watchdog fired
      expect(r.stallTriggered).toBe(true);

      // taskMaxIdleMs must be populated (the idle tracker recorded the gap)
      expect(r.taskMaxIdleMs).not.toBeNull();
      expect(r.taskMaxIdleMs!).toBeGreaterThanOrEqual(0);

      // The lifecycle returned a result (didn't hang forever)
      expect(r.status).toBeDefined();
    },
    30_000, // timeout — watchdog fires in ~5s
  );

  it('clean run with responsive reviewer → stallTriggered=false', async () => {
    reset(false); // reviewer responds normally

    const config = makeConfig({ stallTimeoutMs: 5000, timeoutMs: 300_000 });
    const cwd = makeRepo();

    const results = await runTasks(
      [
        {
          prompt: 'edit src/a.ts. Done when tsc passes.',
          agentType: 'standard' as const,
          cwd,
          reviewPolicy: 'spec_only',
        } as any,
      ],
      config,
    );

    const r = results[0];
    expect(r.status).toBe('ok');
    // stallTriggered should be false/undefined because the watchdog never fired
    expect(r.stallTriggered).toBeFalsy();
    expect(specReviewerCalls).toBeGreaterThanOrEqual(1);
  });
});
