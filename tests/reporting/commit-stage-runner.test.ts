import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitStageRunner } from '../../packages/core/src/reporting/commit-stage-runner.js';
import { initGitRepo, commit } from '../helpers/git-repo.js';

describe('CommitStageRunner', () => {
  it('commits expected files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csr-'));
    initGitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hi');
    commit(dir, 'base', ['a.txt']);
    writeFileSync(join(dir, 'b.txt'), 'bye');
    const r = new CommitStageRunner();
    const res = r.run({ cwd: dir, message: 'add b', expectedFiles: ['b.txt'] });
    expect(res.commitSha).toBeTruthy();
    expect(res.errorCode).toBeUndefined();
  });

  it('emits validator_dirty_worktree on extra unstaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csr-'));
    initGitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hi');
    commit(dir, 'base', ['a.txt']);
    writeFileSync(join(dir, 'b.txt'), 'expected');
    writeFileSync(join(dir, 'c.txt'), 'unexpected');   // dirty
    const r = new CommitStageRunner();
    const res = r.run({ cwd: dir, message: 'add b', expectedFiles: ['b.txt'] });
    expect(res.errorCode).toBe('validator_dirty_worktree');
  });
});
