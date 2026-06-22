import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager } from '../../packages/core/src/unified/worktree-manager.js';

describe('WorktreeManager', () => {
  const mockExec = (stdout = '') =>
    vi.fn().mockResolvedValue({ stdout, stderr: '' });

  const mockFs = (hasPackageJson = false) => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: hasPackageJson
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('ENOENT')),
  });

  it('create calls git worktree add with correct branch', async () => {
    const exec = mockExec();
    const fs = mockFs();
    const mgr = new WorktreeManager(exec, fs);
    const info = await mgr.create('/repo', 'task-abc12345', 'delegate');

    expect(info.branch).toBe('mma/delegate-task-abc');
    expect(info.path).toContain('.mma/worktrees/task-abc');
    expect(info.hasChanges).toBe(false);
    expect(info.merged).toBe(false);

    expect(fs.mkdir).toHaveBeenCalledOnce();

    const firstCall = exec.mock.calls[0];
    expect(firstCall[0]).toBe('git');
    expect(firstCall[1]).toContain('worktree');
    expect(firstCall[1]).toContain('add');
    expect(firstCall[1]).toContain('-b');
    expect(firstCall[1]).toContain('mma/delegate-task-abc');
  });

  it('create runs pnpm install when package.json exists', async () => {
    const exec = mockExec();
    const fs = mockFs(true);
    const mgr = new WorktreeManager(exec, fs);
    await mgr.create('/repo', 'task-abc12345', 'delegate');

    expect(exec).toHaveBeenCalledTimes(2);
    const pnpmCall = exec.mock.calls[1];
    expect(pnpmCall[0]).toBe('pnpm');
    expect(pnpmCall[1]).toContain('install');
  });

  it('create retries worktree-add on lock contention, cleaning partial state between attempts', async () => {
    // 1st add: partial run hit the .git/config lock (branch left behind).
    // 2nd add (after cleanup): "branch already exists" (the non-idempotent trap).
    // 3rd add: succeeds.
    const exec = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('add failed'), { stderr: 'could not lock config file .git/config: File exists' }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: worktree prune
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: branch -D
      .mockRejectedValueOnce(Object.assign(new Error('add failed'), { stderr: "fatal: a branch named 'mma/delegate-task-abc' already exists" }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: worktree prune
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: branch -D
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // 3rd add succeeds
    const mgr = new WorktreeManager(exec, mockFs(false));
    const info = await mgr.create('/repo', 'task-abc12345', 'delegate');
    expect(info.branch).toBe('mma/delegate-task-abc');
    // Verify it actually retried the add (3 add calls) + cleaned up between them.
    const addCalls = exec.mock.calls.filter((c) => c[1][0] === 'worktree' && c[1][1] === 'add');
    expect(addCalls.length).toBe(3);
    expect(exec.mock.calls.some((c) => c[1][0] === 'branch' && c[1][1] === '-D')).toBe(true);
  });

  it('create throws immediately on a non-retryable add error', async () => {
    const exec = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('add failed'), { stderr: "fatal: invalid reference: bogus-base" }),
    );
    const mgr = new WorktreeManager(exec, mockFs(false));
    await expect(mgr.create('/repo', 'task-abc12345', 'delegate')).rejects.toThrow();
    const addCalls = exec.mock.calls.filter((c) => c[1][0] === 'worktree' && c[1][1] === 'add');
    expect(addCalls.length).toBe(1); // no retry on a real error
  });

  it('hasChanges returns false for clean worktree', async () => {
    const mgr = new WorktreeManager(mockExec(''));
    expect(await mgr.hasChanges('/repo/.mma/worktrees/abc')).toBe(false);
  });

  it('hasChanges returns true for dirty worktree', async () => {
    const mgr = new WorktreeManager(mockExec(' M src/file.ts\n'));
    expect(await mgr.hasChanges('/repo/.mma/worktrees/abc')).toBe(true);
  });

  it('mergeAndCleanup removes when clean (no changes)', async () => {
    const exec = mockExec('');
    const mgr = new WorktreeManager(exec, mockFs(true));
    const info = await mgr.mergeAndCleanup(
      '/repo/.mma/worktrees/abc',
      'mma/delegate-abc',
      '/repo',
    );
    expect(info.hasChanges).toBe(false);
    expect(info.merged).toBe(false);

    // git status, git worktree remove, git branch -D
    const calls = exec.mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[0][1]).toContain('--porcelain');
    expect(calls[1][1]).toContain('remove');
    expect(calls[2][1]).toContain('-D');
  });

  it('mergeAndCleanup auto-commits + merges + cleans up when dirty', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges → dirty
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git merge
      .mockResolvedValueOnce({ stdout: 'file.ts\n', stderr: '' }) // git diff --name-only
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git branch -D

    const mgr = new WorktreeManager(exec, mockFs(true));
    const info = await mgr.mergeAndCleanup(
      '/repo/.mma/worktrees/abc',
      'mma/delegate-abc',
      '/repo',
    );

    expect(info.hasChanges).toBe(true);
    expect(info.merged).toBe(true);
    expect(info.filesChanged).toEqual(['file.ts']);

    const calls = exec.mock.calls;
    expect(calls[0][1]).toContain('--porcelain');
    expect(calls[1][1]).toEqual(['add', '-A']);
    expect(calls[2][1]).toContain('commit');
    expect(calls[3][1]).toContain('merge');
    expect(calls[3][1]).toContain('mma/delegate-abc');
    expect(calls[3][2].cwd).toBe('/repo'); // merge runs in original cwd
    expect(calls[4][1]).toContain('diff'); // git diff --name-only for filesChanged
    expect(calls[5][1]).toContain('remove');
    expect(calls[6][1]).toContain('-D');
  });

  it('mergeAndCleanup preserves worktree on merge conflict', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges → dirty
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockRejectedValueOnce(new Error('merge conflict')) // git merge fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git merge --abort

    const mgr = new WorktreeManager(exec, mockFs(true));
    const info = await mgr.mergeAndCleanup(
      '/repo/.mma/worktrees/abc',
      'mma/delegate-abc',
      '/repo',
    );

    expect(info.hasChanges).toBe(true);
    expect(info.merged).toBe(false);
    // Worktree NOT removed — preserved for manual resolution
    expect(exec.mock.calls.map(c => c[1][0])).not.toContain('worktree');
  });

  it('mergeAndCleanup degrades gracefully when the worktree dir is gone', async () => {
    // Worktree directory vanished (OS reap, or an agent deleted it). Must NOT
    // crash with `spawn git ENOENT` — prune the stale registration + branch and
    // report not-merged.
    const exec = mockExec('');
    const fs = mockFs(false); // access rejects → dir missing
    const mgr = new WorktreeManager(exec, fs);
    const info = await mgr.mergeAndCleanup(
      '/repo/.mma/worktrees/abc',
      'mma/delegate-abc',
      '/repo',
    );

    expect(info.merged).toBe(false);
    expect(info.hasChanges).toBe(false);
    // No git ran with cwd=worktree path; prune + branch -D ran in the original cwd.
    const calls = exec.mock.calls;
    expect(calls.every((c) => c[2].cwd === '/repo')).toBe(true);
    expect(calls.map((c) => c[1].join(' '))).toEqual(['worktree prune', 'branch -D mma/delegate-abc']);
  });

});
