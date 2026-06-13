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

    // mkdir should have been called to create .mma/worktrees
    expect(fs.mkdir).toHaveBeenCalledOnce();

    // First exec call should be git worktree add
    expect(exec).toHaveBeenCalled();
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

    // Should have called git worktree add + pnpm install
    expect(exec).toHaveBeenCalledTimes(2);
    const pnpmCall = exec.mock.calls[1];
    expect(pnpmCall[0]).toBe('pnpm');
    expect(pnpmCall[1]).toContain('install');
    expect(pnpmCall[1]).toContain('--frozen-lockfile');
  });

  it('hasChanges returns false for clean worktree', async () => {
    const mgr = new WorktreeManager(mockExec(''));
    expect(await mgr.hasChanges('/repo/.mma/worktrees/abc')).toBe(false);
  });

  it('hasChanges returns true for dirty worktree', async () => {
    const mgr = new WorktreeManager(mockExec(' M src/file.ts\n'));
    expect(await mgr.hasChanges('/repo/.mma/worktrees/abc')).toBe(true);
  });

  it('cleanup removes when clean', async () => {
    const exec = mockExec('');
    const mgr = new WorktreeManager(exec);
    const preserved = await mgr.cleanup(
      '/repo/.mma/worktrees/abc',
      'mma/delegate-abc',
    );
    expect(preserved).toBe(false);

    // Should have called: git status --porcelain, git worktree remove, git branch -D
    const calls = exec.mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[0][1]).toContain('--porcelain');
    expect(calls[1][1]).toContain('remove');
    expect(calls[2][1]).toContain('-D');
    expect(calls[2][1]).toContain('mma/delegate-abc');
  });

  it('cleanup preserves when dirty', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges
      .mockResolvedValue({ stdout: '', stderr: '' });
    const mgr = new WorktreeManager(exec);
    const preserved = await mgr.cleanup(
      '/repo/.mma/worktrees/abc',
      'mma/delegate-abc',
    );
    expect(preserved).toBe(true);

    // Should only have called git status --porcelain (no remove)
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('getInfo returns current state', async () => {
    const mgr = new WorktreeManager(mockExec(' M dirty.ts\n'));
    const info = await mgr.getInfo('/repo/.mma/worktrees/abc', 'mma/delegate-abc');
    expect(info).toEqual({
      branch: 'mma/delegate-abc',
      path: '/repo/.mma/worktrees/abc',
      hasChanges: true,
    });
  });
});
