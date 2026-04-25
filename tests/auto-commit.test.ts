import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoCommitFiles, composeCommitMessage } from '@zhixuan92/multi-model-agent-core/auto-commit';

vi.mock('child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(Buffer.from('abc1234\n')),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

describe('composeCommitMessage', () => {
  it('composes "type(scope): subject" with body', () => {
    const msg = composeCommitMessage({ type: 'feat', scope: 'core', subject: 'add x', body: 'why\n\nbecause.' });
    expect(msg).toBe('feat(core): add x\n\nwhy\n\nbecause.');
  });

  it('omits scope when absent', () => {
    expect(composeCommitMessage({ type: 'fix', subject: 'bar' })).toBe('fix: bar');
  });

  it('omits body when absent', () => {
    expect(composeCommitMessage({ type: 'docs', scope: 'spec', subject: 'baz' })).toBe('docs(spec): baz');
  });
});

describe('autoCommitFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from('abc1234\n'));
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('commits files and returns SHA', () => {
    const result = autoCommitFiles({
      filesWritten: ['src/a.ts', 'src/b.ts'],
      commit: { type: 'feat', subject: 'implemented auth' },
      cwd: '/project',
    });
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts', 'src/b.ts'], { cwd: '/project' });
    expect(execFileSync).toHaveBeenCalledWith('git', ['commit', '-m', 'feat: implemented auth', '--', 'src/a.ts', 'src/b.ts'], { cwd: '/project' });
    expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], { cwd: '/project' });
    expect(result).toEqual({ sha: 'abc1234' });
  });

  it('skips paths outside cwd', () => {
    const result = autoCommitFiles({
      filesWritten: ['/other/dir/file.ts', 'src/a.ts'],
      commit: { type: 'chore', subject: 'done' },
      cwd: '/project',
    });
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts'], { cwd: '/project' });
    expect(result).toEqual({ sha: 'abc1234' });
  });

  it('returns empty when all paths filtered out', () => {
    const result = autoCommitFiles({
      filesWritten: ['/other/dir/file.ts'],
      commit: { type: 'chore', subject: 'done' },
      cwd: '/project',
    });
    expect(execFileSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('resolves relative paths within cwd', () => {
    autoCommitFiles({
      filesWritten: ['src/a.ts'],
      commit: { type: 'chore', subject: 'done' },
      cwd: '/project',
    });
    // src/a.ts resolves to /project/src/a.ts which is inside /project
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts'], { cwd: '/project' });
  });

  it('skips relative paths that escape cwd', () => {
    const result = autoCommitFiles({
      filesWritten: ['../outside.ts', 'src/a.ts'],
      commit: { type: 'chore', subject: 'done' },
      cwd: '/project',
    });
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts'], { cwd: '/project' });
    expect(result).toEqual({ sha: 'abc1234' });
  });

  it('silently skips nothing-to-commit', () => {
    const nothingError = new Error('nothing to commit');
    (nothingError as any).stderr = Buffer.from('nothing to commit, working tree clean');
    (execFileSync as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => Buffer.from('')) // git add succeeds
      .mockImplementationOnce(() => { throw nothingError; }); // git commit fails
    const result = autoCommitFiles({
      filesWritten: ['src/a.ts'],
      commit: { type: 'chore', subject: 'done' },
      cwd: '/project',
    });
    expect(result).toEqual({}); // no sha, no error
  });

  it('captures other git errors in commitError', () => {
    const hookError = new Error('pre-commit hook failed');
    (execFileSync as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => Buffer.from('')) // git add succeeds
      .mockImplementationOnce(() => { throw hookError; }); // git commit fails
    const result = autoCommitFiles({
      filesWritten: ['src/a.ts'],
      commit: { type: 'chore', subject: 'done' },
      cwd: '/project',
    });
    expect(result).toEqual({ error: 'pre-commit hook failed' });
  });
});
