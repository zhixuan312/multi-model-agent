import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCommitHandler } from '../../../packages/core/src/lifecycle/handlers/git-commit-handler.js';

describe('gitCommitHandler (v4.4.x)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mma-commit-'));
    execSync('git init -q && git config user.email a@b && git config user.name x', { cwd });
    writeFileSync(join(cwd, '.gitkeep'), '');
    execSync('git add . && git commit -qm initial', { cwd });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function preSha(): string {
    return execSync('git rev-parse HEAD', { cwd }).toString().trim();
  }

  it('skips with no_repo when cwd is not a git repo', async () => {
    const noRepo = mkdtempSync(join(tmpdir(), 'mma-noggit-'));
    writeFileSync(join(noRepo, 'x.txt'), 'x');
    const state: any = {
      cwd: noRepo,
      lastRunResult: { summary: 'x', filesChanged: ['x.txt'], validationsRun: [] },
      executionContext: { getSession: () => null },
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.commitSkipReason).toBe('no_repo');
    rmSync(noRepo, { recursive: true, force: true });
  });

  it('skips with no_diff when nothing changed', async () => {
    const state: any = {
      cwd,
      lastRunResult: { summary: 'x', filesChanged: [], validationsRun: [] },
      executionContext: { getSession: () => null },
      preTaskHeadSha: preSha(),
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.commitSkipReason).toBe('no_diff');
  });

  it('skips with validation_failed when a validation has passed:false', async () => {
    writeFileSync(join(cwd, 'new.txt'), 'hello');
    const state: any = {
      cwd,
      lastRunResult: {
        summary: 'x', filesChanged: ['new.txt'],
        validationsRun: [{ name: 'npm test', passed: false, output: 'failed' }],
      },
      executionContext: { getSession: () => null },
      preTaskHeadSha: preSha(),
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.commitSkipReason).toBe('validation_failed');
  });

  it('skips with validation_stale when Rework ran but validationsRun is empty', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'a');
    const state: any = {
      cwd,
      lastRunResult: { summary: 'x', filesChanged: ['a.txt'], validationsRun: [] },
      executionContext: { getSession: () => null },
      preTaskHeadSha: preSha(),
      reworkApplied: true,
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.commitSkipReason).toBe('validation_stale');
  });

  it('skips with worker_committed_out_of_band when HEAD moved', async () => {
    const before = preSha();
    writeFileSync(join(cwd, 'a.txt'), 'a');
    execSync('git add . && git commit -qm "worker did it"', { cwd });
    const state: any = {
      cwd,
      lastRunResult: { summary: 'x', filesChanged: ['a.txt'], validationsRun: [] },
      executionContext: { getSession: () => null },
      preTaskHeadSha: before,
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.commitSkipReason).toBe('worker_committed_out_of_band');
    expect(state.lastRunResult.detectedHeadSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('commits with worker-supplied commitMessage (no model call)', async () => {
    writeFileSync(join(cwd, 'b.txt'), 'b');
    const send = vi.fn(() => { throw new Error('must not call'); });
    const state: any = {
      cwd,
      lastRunResult: {
        summary: 'x', filesChanged: ['b.txt'], validationsRun: [],
        commitMessage: 'feat: add b',
      },
      executionContext: { getSession: () => ({ send, close: vi.fn() }) },
      preTaskHeadSha: preSha(),
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.committed).toBe(true);
    expect(state.lastRunResult.commitMessage).toBe('feat: add b');
    expect(state.lastRunResult.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(send).not.toHaveBeenCalled();
  });

  it('generates commit message via standard session when worker did not supply one', async () => {
    writeFileSync(join(cwd, 'c.txt'), 'c');
    const send = vi.fn().mockResolvedValue({
      output: 'fix(parser): handle empty input',
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      filesRead: [], filesWritten: [], toolCallsByName: {},
      turns: 1, durationMs: 0, costUSD: null, terminationReason: 'ok',
    });
    const state: any = {
      cwd,
      lastRunResult: { summary: 'made a fix', filesChanged: ['c.txt'], validationsRun: [] },
      executionContext: { getSession: () => ({ send, close: vi.fn() }) },
      preTaskHeadSha: preSha(),
    };
    await gitCommitHandler(state);
    expect(state.lastRunResult.committed).toBe(true);
    expect(state.lastRunResult.commitMessage).toBe('fix(parser): handle empty input');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
