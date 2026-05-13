import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
// Import whichever task-executor helper captures preTask state. Path may differ;
// check the actual export name during implementation.
import { capturePreTaskState } from '../../../packages/core/src/lifecycle/handlers/task-executor.js';

describe('task-executor preTask capture', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mma-pretask-'));
    execSync('git init', { cwd });
    execSync('git config user.email t@t.com && git config user.name t', { cwd, shell: '/bin/bash' });
    writeFileSync(join(cwd, 'tracked.txt'), 'tracked');
    execSync('git add . && git commit -m init', { cwd, shell: '/bin/bash' });
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
});