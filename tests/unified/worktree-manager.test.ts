import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager } from '../../packages/core/src/unified/worktree-manager.js';

describe('WorktreeManager', () => {
  const mockExec = (stdout = '') =>
    vi.fn().mockResolvedValue({ stdout, stderr: '' });

  // access() now serves TWO probes: `.git` (git-repo detection) and `package.json` (pnpm install).
  // `isGit` defaults true so existing git-path tests are unchanged; `hasPackageJson` gates install.
  const mockFs = (hasPackageJson = false, isGit = true) => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockImplementation(async (p: string) => {
      if (p.endsWith('.git')) {
        if (isGit) return undefined;
        throw new Error('ENOENT');
      }
      // package.json probe
      if (hasPackageJson) return undefined;
      throw new Error('ENOENT');
    }),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  });

  it('create returns an in-place execution target when the `.git` entry is absent', async () => {
    // Non-git target: `.git` probe rejects → create() skips the worktree and runs in place.
    const exec = mockExec();
    const fs = mockFs(false, false); // isGit = false
    const mgr = new WorktreeManager(exec, fs);

    const info = await mgr.create('/plain-dir', 'task-abc12345', 'delegate');

    expect(info).toEqual({ branch: '', path: '/plain-dir', hasChanges: false, merged: false });
    // No git commands and no worktree mkdir for a non-git target.
    expect(exec).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
  });

  it('a git-repo SUBDIR (no direct `.git`) runs in-place — intentional per the `.git`-entry contract', async () => {
    // Detection is a `.git`-ENTRY check on the given cwd, so a subdir of a repo (which has no
    // `.git` of its own) is treated as non-git → in-place. This is deliberate: /mma-flow only
    // ever dispatches write routes at a repo ROOT, never a subdir. Locking the behavior here.
    const exec = mockExec();
    const fs = mockFs(false, false); // subdir: no `.git` entry at this cwd
    const mgr = new WorktreeManager(exec, fs);

    const info = await mgr.create('/repo/src', 'task-abc12345', 'delegate');

    expect(info).toEqual({ branch: '', path: '/repo/src', hasChanges: false, merged: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it('remove force-removes a worktree, prunes, and deletes its branch (best-effort)', async () => {
    const exec = mockExec();
    const mgr = new WorktreeManager(exec, mockFs());
    await mgr.remove('/repo/.mma/worktrees/abc12345', 'mma/delegate-abc12345', '/repo');
    const calls = exec.mock.calls.map((c) => c[1].join(' '));
    expect(calls).toContain('worktree remove --force /repo/.mma/worktrees/abc12345');
    expect(calls).toContain('worktree prune');
    expect(calls).toContain('branch -D mma/delegate-abc12345');
  });

  it('reapOrphans removes worktrees whose task is NOT active + their branches, keeps active ones', async () => {
    // Two worktree dirs: dead1111 (inactive → reap), live2222 (active → keep).
    const exec = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'for-each-ref') return { stdout: 'mma/delegate-dead1111\nmma/execute_plan-live2222\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const fs = { ...mockFs(), readdir: vi.fn().mockResolvedValue(['dead1111', 'live2222']) };
    const mgr = new WorktreeManager(exec, fs);

    const reaped = await mgr.reapOrphans('/repo', (id) => id === 'live2222');

    expect(reaped).toBe(1);
    const calls = exec.mock.calls.map((c) => c[1].join(' '));
    expect(calls).toContain('worktree remove --force /repo/.mma/worktrees/dead1111');
    expect(calls).toContain('branch -D mma/delegate-dead1111');
    // The active task's worktree + branch are untouched.
    expect(calls).not.toContain('worktree remove --force /repo/.mma/worktrees/live2222');
    expect(calls).not.toContain('branch -D mma/execute_plan-live2222');
  });

  it('reapOrphans is a no-op for a non-git cwd and when no worktrees dir exists', async () => {
    const execNonGit = mockExec();
    const nonGit = new WorktreeManager(execNonGit, mockFs(false, false)); // .git absent
    expect(await nonGit.reapOrphans('/plain', () => false)).toBe(0);
    expect(execNonGit).not.toHaveBeenCalled();

    const execNoDir = mockExec();
    const fsNoDir = { ...mockFs(), readdir: vi.fn().mockRejectedValue(new Error('ENOENT')) };
    const noDir = new WorktreeManager(execNoDir, fsNoDir);
    expect(await noDir.reapOrphans('/repo', () => false)).toBe(0);
  });

  it('mergeAndCleanup is a no-op for in-place execution (empty branch, path === cwd)', async () => {
    const exec = mockExec();
    const fs = mockFs();
    const mgr = new WorktreeManager(exec, fs);

    const info = await mgr.mergeAndCleanup('/plain-dir', '', '/plain-dir');

    expect(info).toEqual({ branch: '', path: '/plain-dir', hasChanges: false, merged: false });
    expect(exec).not.toHaveBeenCalled(); // no git cleanup for in-place execution
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

  it('create retries worktree-add on a concurrent worktree-admin read race (commondir / Undefined error: 0)', async () => {
    // `git worktree add` scans `.git/worktrees/*` for existing trees; a CONCURRENT prune/remove
    // (another task's cleanup, or the dispatch-time reaper) can unlink a peer's admin files
    // mid-scan, so add aborts reading `commondir`. On macOS the errno surfaces as the generic
    // "Undefined error: 0". It is transient — the peer op finishes in ms — so add must RETRY.
    const exec = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Command failed: git worktree add'), {
        stderr: "fatal: failed to read '.git/worktrees/8fc494a7/commondir': Undefined error: 0",
      }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: worktree prune
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // cleanup: branch -D
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // 2nd add succeeds
    const mgr = new WorktreeManager(exec, mockFs(false));
    const info = await mgr.create('/repo', 'task-abc12345', 'delegate');
    expect(info.branch).toBe('mma/delegate-task-abc');
    const addCalls = exec.mock.calls.filter((c) => c[1][0] === 'worktree' && c[1][1] === 'add');
    expect(addCalls.length).toBe(2); // retried the add after the admin-read race
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

    // clean worktree → status, then the "is the branch ahead?" probe (merge-base / rev-list / diff;
    // rev-list count is empty → NaN → not ahead), then worktree remove + branch -D.
    const calls = exec.mock.calls;
    expect(calls.length).toBe(6);
    expect(calls[0][1]).toContain('--porcelain');
    expect(calls[1][1]).toContain('merge-base');
    expect(calls[2][1]).toContain('rev-list');
    expect(calls[3][1]).toContain('diff');
    expect(calls[4][1]).toContain('remove');
    expect(calls[5][1]).toContain('-D');
  });

  it('mergeAndCleanup auto-commits + merges + cleans up when dirty', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges → dirty
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce({ stdout: 'base0000\n', stderr: '' }) // git merge-base branch HEAD
      .mockResolvedValueOnce({ stdout: '1\n', stderr: '' }) // git rev-list --count base..branch (ahead=1)
      .mockResolvedValueOnce({ stdout: 'file.ts\n', stderr: '' }) // git diff --name-only base branch (filesChanged)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git merge
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
    // Internal staging commit bypasses the target repo's hooks + carries a guaranteed identity.
    expect(calls[2][1]).toContain('--no-verify');
    expect(calls[2][1]).toContain('user.email=mma@localhost');
    expect(calls[3][1]).toContain('merge-base'); // fork point
    expect(calls[4][1]).toContain('rev-list'); // is the branch ahead? (truthful merge signal)
    expect(calls[5][1]).toContain('diff'); // git diff --name-only base branch → filesChanged
    expect(calls[6][1]).toContain('merge');
    expect(calls[6][1]).toContain('mma/delegate-abc');
    expect(calls[6][2].cwd).toBe('/repo'); // merge runs in original cwd
    expect(calls[7][1]).toContain('remove');
    expect(calls[8][1]).toContain('-D');
  });

  it('mergeAndCleanup preserves worktree on merge conflict', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges → dirty
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce({ stdout: 'base0000\n', stderr: '' }) // git merge-base branch HEAD
      .mockResolvedValueOnce({ stdout: '1\n', stderr: '' }) // git rev-list --count base..branch (ahead=1)
      .mockResolvedValueOnce({ stdout: 'file.ts\n', stderr: '' }) // git diff --name-only (filesChanged)
      .mockRejectedValueOnce(new Error('not fast-forward')) // git merge --ff-only fails
      .mockResolvedValueOnce({ stdout: 'targethead\n', stderr: '' }) // git rev-parse HEAD (rebase target)
      .mockRejectedValueOnce(new Error('rebase conflict')) // git rebase (in worktree) fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git rebase --abort (in worktree)

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

  it('rebases in the worktree and lands when the target advanced (ff-only fails)', async () => {
    // The target moved while the worker ran (concurrent peer, or the user committing to their repo).
    // ff-only fails; the fix rebases the branch onto the new target IN THE WORKTREE (the main repo
    // cannot check out a branch already used by a worktree — that threw before → merged:false → silent
    // drop), then fast-forwards. Regression for the cross-repo/diverged merge-back loss.
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges → dirty
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce({ stdout: 'base0000\n', stderr: '' }) // git merge-base
      .mockResolvedValueOnce({ stdout: '1\n', stderr: '' }) // rev-list --count (ahead)
      .mockResolvedValueOnce({ stdout: 'file.ts\n', stderr: '' }) // git diff (filesChanged)
      .mockRejectedValueOnce(new Error('Not possible to fast-forward')) // git merge --ff-only fails
      .mockResolvedValueOnce({ stdout: 'targethead0\n', stderr: '' }) // git rev-parse HEAD (rebase target)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git rebase targethead0 (in worktree) OK
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git merge --ff-only (retry) OK
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git branch -D
    const mgr = new WorktreeManager(exec, mockFs(true));
    const info = await mgr.mergeAndCleanup('/repo/.mma/worktrees/abc', 'mma/delegate-abc', '/repo');
    expect(info.merged).toBe(true);
    expect(info.filesChanged).toEqual(['file.ts']);
    // The rebase ran IN THE WORKTREE (cwd = worktree path) onto the target HEAD, not in the main repo.
    const rebaseCall = exec.mock.calls.find((c) => c[1][0] === 'rebase' && c[1][1] !== '--abort');
    expect(rebaseCall[1]).toContain('targethead0');
    expect(rebaseCall[2].cwd).toBe('/repo/.mma/worktrees/abc');
  });

  it('a genuine staging-commit failure reports merged:false — never a silent merged:true', async () => {
    // Regression for the cross-repo silent-data-loss bug (B-317). A real commit failure must NOT be
    // swallowed as "nothing to commit" and then reported as a successful merge via a no-op
    // `merge --ff-only` ("Already up to date"). The worker's work never landed → merged:false, and
    // the worktree is preserved (not removed) so the changes are not destroyed.
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '' }) // hasChanges → dirty
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add -A
      .mockRejectedValueOnce(Object.assign(new Error('commit failed'), { stderr: 'fatal: unable to write commit object' }));
    const mgr = new WorktreeManager(exec, mockFs(true));
    const info = await mgr.mergeAndCleanup('/repo/.mma/worktrees/abc', 'mma/delegate-abc', '/repo');
    expect(info.merged).toBe(false);
    expect(info.hasChanges).toBe(true);
    // Never proceeded to a merge (no false "Already up to date") and never removed the worktree.
    const cmds = exec.mock.calls.map((c) => c[1][0]);
    expect(cmds).not.toContain('merge');
    expect(cmds).not.toContain('worktree');
  });

  it('merges a worker self-commit even when the working tree is clean (branch ahead)', async () => {
    // A worker that committed its own changes leaves a clean working tree but a branch AHEAD of the
    // fork point. The old `!dirty` fast path removed the branch WITHOUT merging — losing the work.
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // hasChanges → clean (worker self-committed)
      .mockResolvedValueOnce({ stdout: 'base0000\n', stderr: '' }) // git merge-base
      .mockResolvedValueOnce({ stdout: '2\n', stderr: '' }) // rev-list --count → ahead by 2
      .mockResolvedValueOnce({ stdout: 'a.ts\nb.ts\n', stderr: '' }) // git diff --name-only (filesChanged)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git merge --ff-only
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git worktree remove
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git branch -D
    const mgr = new WorktreeManager(exec, mockFs(true));
    const info = await mgr.mergeAndCleanup('/repo/.mma/worktrees/abc', 'mma/delegate-abc', '/repo');
    expect(info.merged).toBe(true);
    expect(info.filesChanged).toEqual(['a.ts', 'b.ts']);
    // Clean working tree → no add/commit; went straight to the ahead-check + merge.
    const cmds = exec.mock.calls.map((c) => c[1][0]);
    expect(cmds).not.toContain('add');
    expect(cmds).toContain('merge');
  });

});
