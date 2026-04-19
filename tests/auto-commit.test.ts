import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoCommitFiles } from '@zhixuan92/multi-model-agent-core/auto-commit';

vi.mock('child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(Buffer.from('abc1234\n')),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';

describe('autoCommitFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from('abc1234\n'));
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('commits files and returns SHA', () => {
    const result = autoCommitFiles(['src/a.ts', 'src/b.ts'], 'Implemented auth', '/project');
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts', 'src/b.ts'], { cwd: '/project' });
    expect(execFileSync).toHaveBeenCalledWith('git', ['commit', '-m', 'Implemented auth', '--', 'src/a.ts', 'src/b.ts'], { cwd: '/project' });
    expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], { cwd: '/project' });
    expect(result).toEqual({ sha: 'abc1234' });
  });

  it('uses fallback message when summary is undefined', () => {
    autoCommitFiles(['src/a.ts'], undefined, '/project');
    expect(execFileSync).toHaveBeenCalledWith('git', ['commit', '-m', 'worker: task completed', '--', 'src/a.ts'], { cwd: '/project' });
  });

  it('uses fallback message when summary is empty', () => {
    autoCommitFiles(['src/a.ts'], '', '/project');
    expect(execFileSync).toHaveBeenCalledWith('git', ['commit', '-m', 'worker: task completed', '--', 'src/a.ts'], { cwd: '/project' });
  });

  it('skips paths outside cwd', () => {
    const result = autoCommitFiles(['/other/dir/file.ts', 'src/a.ts'], 'done', '/project');
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts'], { cwd: '/project' });
    expect(result).toEqual({ sha: 'abc1234' });
  });

  it('returns empty when all paths filtered out', () => {
    const result = autoCommitFiles(['/other/dir/file.ts'], 'done', '/project');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('resolves relative paths within cwd', () => {
    autoCommitFiles(['src/a.ts'], 'done', '/project');
    // src/a.ts resolves to /project/src/a.ts which is inside /project
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts'], { cwd: '/project' });
  });

  it('skips relative paths that escape cwd', () => {
    const result = autoCommitFiles(['../outside.ts', 'src/a.ts'], 'done', '/project');
    expect(execFileSync).toHaveBeenCalledWith('git', ['add', 'src/a.ts'], { cwd: '/project' });
    expect(result).toEqual({ sha: 'abc1234' });
  });

  it('silently skips nothing-to-commit', () => {
    const nothingError = new Error('nothing to commit');
    (nothingError as any).stderr = Buffer.from('nothing to commit, working tree clean');
    (execFileSync as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => Buffer.from('')) // git add succeeds
      .mockImplementationOnce(() => { throw nothingError; }); // git commit fails
    const result = autoCommitFiles(['src/a.ts'], 'done', '/project');
    expect(result).toEqual({}); // no sha, no error
  });

  it('captures other git errors in commitError', () => {
    const hookError = new Error('pre-commit hook failed');
    (execFileSync as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => Buffer.from('')) // git add succeeds
      .mockImplementationOnce(() => { throw hookError; }); // git commit fails
    const result = autoCommitFiles(['src/a.ts'], 'done', '/project');
    expect(result).toEqual({ error: 'pre-commit hook failed' });
  });
});
