import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider, RunResult } from '../../packages/core/src/types.js';

function initCleanRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-commitgate-'));
  execSync('git init -q && git config user.email t@e && git config user.name T && git config commit.gpgsign false', { cwd });
  writeFileSync(join(cwd, 'README.md'), '# fixture');
  execSync('git add . && git commit -q -m "init"', { cwd });
  return cwd;
}

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'gpt-5', baseUrl: 'http://mock.local', apiKey: 'mock' },
      complex: { type: 'openai-compatible', model: 'gpt-5.2', baseUrl: 'http://mock.local', apiKey: 'mock' },
    },
    defaults: { timeoutMs: 300_000, stallTimeoutMs: 600_000, maxCostUSD: 10, tools: 'full' as const, sandboxPolicy: 'cwd-only' as const },
    server: {
      bind: '127.0.0.1', port: 7337,
      auth: { tokenFile: '/tmp/mock-token' },
      limits: {
        maxBodyBytes: 1_000_000, batchTtlMs: 300_000, idleProjectTimeoutMs: 3_600_000,
        clarificationTimeoutMs: 300_000, projectCap: 10, maxBatchCacheSize: 10,
        maxContextBlockBytes: 100_000, maxContextBlocksPerProject: 10, shutdownDrainMs: 5_000,
      },
      autoUpdateSkills: false,
    },
  };
}

function makeOkResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    // Include the commit block in the correct format: `commit: {...}` on its own line
    output: `## Summary
done

## Files changed
- src/output.ts

## Validations run

## Deviations from brief

## Unresolved

commit: {"type":"feat","subject":"add file"}
`,
    status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01, costDeltaVsParentUSD: null, cachedTokens: null, reasoningTokens: null },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [{ provider: 'mock', status: 'ok', turns: 1, inputTokens: 100, outputTokens: 50, costUSD: 0.01, initialPromptLengthChars: 0, initialPromptHash: '' }],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: 'done' as const,
    terminationReason: { cause: 'finished' as const, turnsUsed: 1, hasFileArtifacts: true, usedShell: false, workerSelfAssessment: 'done', wasPromoted: false },
    retryable: false,
    briefQualityWarnings: [],
    ...overrides,
  };
}

describe('committing stage gating', () => {
  it('emits committing stage when tree is dirty (files written by worker, pending commit)', async () => {
    const cwd = initCleanRepo();
    const config = makeConfig();
    const outFile = 'src/output.ts';

    // Provider writes a file to disk during its run, making the tree dirty
    // after the initial clean-worktree check passes. The file is left
    // uncommitted so the lifecycle runs runCommitStage (treeDirty path).
    const provider: Provider = {
      name: 'mock-file-writer',
      config: config.agents.standard,
      async run(): Promise<RunResult> {
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, outFile), 'export const x = 1;');
        return makeOkResult({ filesWritten: [outFile], toolCalls: [`writeFile(${outFile})`] });
      },
    };

    const task: TaskSpec = {
      prompt: 'create src/output.ts',
      reviewPolicy: 'none',
      autoCommit: true,
      cwd,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider,
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.stageStats).toBeDefined();
    expect(r.stageStats!.committing.entered).toBe(true);
    expect(r.stageStats!.committing.durationMs).toBeGreaterThan(0);
    // runCommitStage should have committed the pending file
    expect(r.commits).toBeDefined();
    expect(r.commits!.length).toBeGreaterThanOrEqual(1);
    expect(r.commits![0].filesChanged).toContain(outFile);
  });

  it('emits committing stage when HEAD moved (worker auto-committed during turn)', async () => {
    const cwd = initCleanRepo();
    const config = makeConfig();

    // Worker auto-commits during its turn — writes file then runs git commit.
    // After the worker returns, the tree is clean but HEAD has moved from
    // baseline. The committing stage wraps recordWorkerCommits (headMoved path).
    const provider: Provider = {
      name: 'mock-auto-committer',
      config: config.agents.standard,
      async run(): Promise<RunResult> {
        mkdirSync(join(cwd, 'src'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'auto.ts'), 'export const auto = true;');
        execSync('git add src/auto.ts && git commit -q -m "auto-commit during turn"', { cwd });
        return makeOkResult({
          filesWritten: ['src/auto.ts'],
          toolCalls: ['Bash(git add src/auto.ts && git commit -q -m "auto-commit during turn")'],
        });
      },
    };

    const task: TaskSpec = {
      prompt: 'create src/auto.ts and commit',
      reviewPolicy: 'none',
      autoCommit: true,
      cwd,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider,
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.stageStats).toBeDefined();
    expect(r.stageStats!.committing.entered).toBe(true);
    expect(r.stageStats!.committing.durationMs).toBeGreaterThan(0);
    // recordWorkerCommits should have captured the auto-commit from git history
    expect(r.commits).toBeDefined();
    expect(r.commits!.length).toBeGreaterThanOrEqual(1);
    expect(r.commits![0].subject).toBe('auto-commit during turn');
  });

  it('does NOT emit committing stage when no files were written and HEAD did not move', async () => {
    const cwd = initCleanRepo();
    const config = makeConfig();

    const provider: Provider = {
      name: 'mock-read-only',
      config: config.agents.standard,
      async run(): Promise<RunResult> {
        return makeOkResult({ filesWritten: [] });
      },
    };

    const task: TaskSpec = {
      prompt: 'read README.md',
      reviewPolicy: 'none',
      autoCommit: true,
      cwd,
    };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider,
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.stageStats).toBeDefined();
    expect(r.stageStats!.committing.entered).toBe(false);
  });
});
