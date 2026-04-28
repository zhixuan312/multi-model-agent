import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MultiModelConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

// Provider state — shared across test cases.
let implementerCalls = 0;
let specReviewerCalls = 0;

// When true, the mock returns quickly but the per-call effectiveTimeoutMs
// captured from delegateWithEscalation's taskDeadlineMs clamping is
// recorded for assertions.
let capturedTimeoutMs: Array<number | undefined> = [];

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: (slot: string) => ({
    name: slot,
    config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
    run: async (prompt: string, opts?: { abortSignal?: AbortSignal; timeoutMs?: number }): Promise<RunResult> => {
      capturedTimeoutMs.push(opts?.timeoutMs);
      if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) {
        specReviewerCalls++;
        return reviewResult;
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
  const cwd = mkdtempSync(join(tmpdir(), 'mma-cap-'));
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
  overrides: { timeoutMs?: number; stallTimeoutMs?: number } = {},
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

function reset() {
  implementerCalls = 0;
  specReviewerCalls = 0;
  capturedTimeoutMs = [];
}

describe('total wall-clock cap', () => {
  it('returns without hanging even when taskDeadlineMs is near', async () => {
    reset();
    // timeoutMs = 1ms — the deadline is immediately in the past.
    // delegateWithEscalation clamps effectiveTimeoutMs to 1ms.
    // The lifecycle should complete (not hang) because the mock
    // provider returns immediately regardless of timeoutMs.
    const config = makeConfig({ timeoutMs: 1, stallTimeoutMs: 120_000 });
    const cwd = makeRepo();

    const results = await runTasks(
      [
        {
          prompt: 'edit src/a.ts. Done when tsc passes.',
          agentType: 'standard' as const,
          cwd,
          reviewPolicy: 'off', // single delegate call, fast path
        } as any,
      ],
      config,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBeDefined();

    // The implementer was called — the lifecycle didn't short-circuit
    // before reaching the delegate step
    expect(implementerCalls).toBeGreaterThanOrEqual(1);
  });

  it('taskDeadlineMs clamping is wired — per-call timeoutMs is forwarded', async () => {
    reset();
    // timeoutMs = 5000ms gives delegateWithEscalation a meaningful budget.
    const config = makeConfig({ timeoutMs: 5000, stallTimeoutMs: 120_000 });
    const cwd = makeRepo();

    const results = await runTasks(
      [
        {
          prompt: 'edit src/a.ts. Done when tsc passes.',
          agentType: 'standard' as const,
          cwd,
          reviewPolicy: 'off',
        } as any,
      ],
      config,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ok');

    // The mock captures whatever effectiveTimeoutMs delegateWithEscalation
    // computed and passed to provider.run(). With task.timeoutMs not set
    // on the TaskSpec, delegateWithEscalation uses undefined as task.timeoutMs.
    // Then it clamps with taskDeadlineMs: effective = min(undefined, remaining)
    // = remaining. So the captured value should be a positive integer (the
    // remaining ms from taskDeadlineMs - Date.now()).
    expect(capturedTimeoutMs.length).toBeGreaterThanOrEqual(1);
    expect(typeof capturedTimeoutMs[0]).toBe('number');
    if (typeof capturedTimeoutMs[0] === 'number') {
      expect(capturedTimeoutMs[0]).toBeGreaterThan(0);
    }
  });

  it('stallTriggered=false when stallTimeoutMs > total cap (different mechanisms)', async () => {
    reset();
    // timeoutMs is tiny but stallTimeoutMs is large — the stall watchdog
    // should NOT fire because activity events keep flowing.
    const config = makeConfig({ timeoutMs: 1, stallTimeoutMs: 120_000 });
    const cwd = makeRepo();

    const results = await runTasks(
      [
        {
          prompt: 'edit src/a.ts. Done when tsc passes.',
          agentType: 'standard' as const,
          cwd,
          reviewPolicy: 'off',
        } as any,
      ],
      config,
    );

    expect(results[0].stallTriggered).toBeFalsy();
  });
});
