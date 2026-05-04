import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommitStageRunner } from '../../packages/core/src/reporting/commit-stage-runner.js';

describe('CommitStageRunner', () => {
  it('commits expected files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csr-'));
    execSync('git init && git config user.email t@t.com && git config user.name t', { cwd: dir, shell: '/bin/bash' });
    writeFileSync(join(dir, 'a.txt'), 'hi');
    execSync('git add a.txt && git commit -m base', { cwd: dir, shell: '/bin/bash' });
    writeFileSync(join(dir, 'b.txt'), 'bye');
    const r = new CommitStageRunner();
    const res = r.run({ cwd: dir, message: 'add b', expectedFiles: ['b.txt'] });
    expect(res.commitSha).toBeTruthy();
    expect(res.errorCode).toBeUndefined();
  });

  it('emits validator_dirty_worktree on extra unstaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'csr-'));
    execSync('git init && git config user.email t@t.com && git config user.name t', { cwd: dir, shell: '/bin/bash' });
    writeFileSync(join(dir, 'a.txt'), 'hi');
    execSync('git add a.txt && git commit -m base', { cwd: dir, shell: '/bin/bash' });
    writeFileSync(join(dir, 'b.txt'), 'expected');
    writeFileSync(join(dir, 'c.txt'), 'unexpected');   // dirty
    const r = new CommitStageRunner();
    const res = r.run({ cwd: dir, message: 'add b', expectedFiles: ['b.txt'] });
    expect(res.errorCode).toBe('validator_dirty_worktree');
  });
});
