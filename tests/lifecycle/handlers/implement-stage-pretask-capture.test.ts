import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Import whichever task-executor helper captures preTask state. Path may differ;
// check the actual export name during implementation.
import { capturePreTaskState } from '../../../packages/core/src/lifecycle/handlers/implement-stage.js';
import { initGitRepo, commit } from '../../helpers/git-repo.js';

describe('task-executor preTask capture', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mma-pretask-'));
    initGitRepo(cwd);
    writeFileSync(join(cwd, 'tracked.txt'), 'tracked');
    commit(cwd, 'init');
    writeFileSync(join(cwd, 'untracked.txt'), 'untracked-existed-pre-task');
  });

  it('captures preTaskHeadSha and preTaskUntrackedFiles together', async () => {
    const state: any = { cwd };
    await capturePreTaskState(state);
    expect(state.preTaskHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.preTaskUntrackedFiles).toBeInstanceOf(Set);
    expect(state.preTaskUntrackedFiles.has(join(cwd, 'untracked.txt'))).toBe(true);
  });

  it('leaves both fields undefined for a non-git cwd', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'mma-pretask-nongit-'));
    const state: any = { cwd: nonGit };
    await capturePreTaskState(state);
    expect(state.preTaskHeadSha).toBeUndefined();
    expect(state.preTaskUntrackedFiles).toBeUndefined();
  });

  it('resolves cwd from executionContext when state.cwd is unset (production wiring)', async () => {
    // Production sets the cwd on state.executionContext.cwd, not state.cwd.
    // Without the fallback, capturePreTaskState early-returns and the whole
    // real-diff safety net (getRealFilesChanged) goes inert.
    const state: any = { executionContext: { cwd } };
    await capturePreTaskState(state);
    expect(state.preTaskHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.preTaskUntrackedFiles).toBeInstanceOf(Set);
    expect(state.preTaskUntrackedFiles.has(join(cwd, 'untracked.txt'))).toBe(true);
    expect(state.cwd).toBe(cwd); // also wires state.cwd for downstream readers
  });
});