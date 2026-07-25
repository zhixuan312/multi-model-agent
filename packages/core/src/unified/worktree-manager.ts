import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, rmdir, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const execFileAsync = promisify(execFileCb);

export interface WorktreeInfo {
  branch: string;
  path: string;
  hasChanges: boolean;
  merged: boolean;
  filesChanged?: string[];
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface FsOps {
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  access(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
}

const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: opts.cwd, windowsHide: true });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
};

const defaultFs: FsOps = {
  mkdir: async (path, opts) => { await mkdir(path, opts); },
  access: async (path) => { await access(path); },
  readdir: async (path) => await readdir(path),
  rm: async (path, opts) => { await rm(path, opts); },
};

/**
 * Concurrent worktree ops on the SAME repo race the shared `.git/config` + ref
 * locks (`git worktree add` registers the new tree in `.git/config`/`.git/worktrees`).
 * These locks are held for milliseconds, so the contention is transient — the
 * fix is to RETRY rather than serialize, which keeps N simultaneous loops on one
 * repo working (each ends up with its own worktree + branch) regardless of how
 * many processes fire at once. Matches git's lock-contention signatures only;
 * a real failure (bad ref, conflict) is surfaced immediately on the last attempt.
 */
const LOCK_ERROR_RE =
  /could not lock config file|file exists|unable to create|index\.lock|cannot lock ref|another git process|\.lock['": ]/i;

/**
 * A CONCURRENT worktree-admin mutation races a `git` command that is scanning
 * `.git/worktrees/*`. `git worktree add` (and, less often, `remove`/`prune`) walks the
 * existing worktree registrations; a peer's prune/remove — another task's cleanup or the
 * dispatch-time reaper's `git worktree prune` — can unlink a sibling's admin files mid-scan,
 * so the command aborts reading its `commondir`/`gitdir`. On macOS the errno surfaces as the
 * generic "Undefined error: 0". Like a lock, this is transient (the peer op finishes in ms),
 * so the fix is to RETRY (with the same partial-state cleanup), not to serialize. Scoped to
 * the worktree-admin read path so a genuine unrelated failure still surfaces immediately.
 */
const WORKTREE_ADMIN_RACE_RE =
  /failed to read [^\n]*\.git[/\\]worktrees[/\\]|(?:commondir|gitdir)[^\n]*(?:No such file|Undefined error)|worktrees[/\\][^\n]*Undefined error: 0/i;

function errText(err: unknown): string {
  return err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
}

/** Transient same-repo git races worth retrying: `.git/config`/ref lock contention OR a
 *  concurrent worktree-admin read race (see {@link WORKTREE_ADMIN_RACE_RE}). */
function isTransientGitRace(err: unknown): boolean {
  const msg = errText(err);
  return LOCK_ERROR_RE.test(msg) || WORKTREE_ADMIN_RACE_RE.test(msg);
}

/** `git worktree add` is non-idempotent: a lock-interrupted partial run leaves the
 *  branch/worktree behind, so a blind retry fails "already exists". We clean up and
 *  retry on EITHER a transient race OR the already-exists trap. */
function isAddRetryable(err: unknown): boolean {
  return isTransientGitRace(err) || /already (exists|checked out|used by worktree)/i.test(errText(err));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WorktreeManager {
  private readonly exec: ExecFn;
  private readonly fs: FsOps;

  constructor(exec?: ExecFn, fs?: FsOps) {
    this.exec = exec ?? defaultExec;
    this.fs = fs ?? defaultFs;
  }

  /**
   * Run a git command, retrying on a transient same-repo git race — `.git/config`/ref lock
   * contention OR a concurrent worktree-admin read race — so concurrent same-repo worktree
   * ops don't break each other. Up to 8 attempts with linear backoff (~50ms → ~400ms); a
   * non-transient error throws immediately.
   */
  private async gitWithRetry(
    args: string[],
    opts: { cwd: string; windowsHide?: boolean },
  ): Promise<{ stdout: string; stderr: string }> {
    const maxAttempts = 8;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.exec('git', args, { ...opts, windowsHide: true });
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isTransientGitRace(err)) throw err;
        await sleep(50 * attempt);
      }
    }
    throw lastErr;
  }

  /**
   * `git worktree add <dir> -b <branch>` with cleanup-aware retry. Concurrent adds
   * on the same repo race the shared `.git/config` lock; a partial run leaves the
   * branch (and worktree dir) behind, so before each retry we tear those down —
   * making the add idempotent so N simultaneous tasks each get their own worktree.
   */
  private async addWorktreeWithCleanup(cwd: string, worktreeDir: string, branch: string): Promise<void> {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.exec('git', ['worktree', 'add', worktreeDir, '-b', branch], { cwd, windowsHide: true });
        return;
      } catch (err) {
        if (attempt === maxAttempts || !isAddRetryable(err)) throw err;
        // Tear down partial state (best-effort) so the retry starts clean.
        await this.exec('git', ['worktree', 'remove', '--force', worktreeDir], { cwd, windowsHide: true }).catch(() => undefined);
        await this.exec('git', ['worktree', 'prune'], { cwd, windowsHide: true }).catch(() => undefined);
        await this.exec('git', ['branch', '-D', branch], { cwd, windowsHide: true }).catch(() => undefined);
        await sleep(50 * attempt);
      }
    }
  }

  /**
   * Is `cwd` a git repository? Detection is a `.git` ENTRY check (file OR directory), not
   * `git rev-parse`. Rationale: it is the single detection rule across this feature (topology
   * detection also keys on a child's `.git`), `fs.access` succeeds whether `.git` is a directory
   * (repo root) or a FILE (a linked worktree), and write-route `cwd` is always a repo root or a
   * plain non-git folder — never a repo subdir — so the subdir-walk semantics of `git rev-parse`
   * add nothing. This replaces the deleted route-local `isGitRepo` helper as the single source of
   * truth for write-route git detection.
   */
  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await this.fs.access(join(cwd, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async create(cwd: string, taskId: string, type: string): Promise<WorktreeInfo> {
    // Non-git target → in-place execution. Skip `git worktree add` entirely and run directly in
    // `cwd` (the `cwd-only` sandbox already confines the worker). Signalled by an empty branch and
    // a path equal to the original cwd; mergeAndCleanup() treats that pair as a no-op.
    if (!(await this.isGitRepo(cwd))) {
      return { branch: '', path: cwd, hasChanges: false, merged: false };
    }

    const shortId = taskId.slice(0, 8);
    const branch = `mma/${type}-${shortId}`;
    const worktreeDir = join(cwd, '.mma', 'worktrees', shortId);

    await this.fs.mkdir(join(cwd, '.mma', 'worktrees'), { recursive: true });
    await this.addWorktreeWithCleanup(cwd, worktreeDir, branch);

    try {
      await this.fs.access(join(worktreeDir, 'package.json'));
      await this.exec('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreeDir });
    } catch {
      // No package.json — skip install
    }

    return { branch, path: worktreeDir, hasChanges: false, merged: false };
  }

  async hasChanges(worktreePath: string): Promise<boolean> {
    const { stdout } = await this.exec('git', ['status', '--porcelain'], { cwd: worktreePath, windowsHide: true });
    return stdout.trim().length > 0;
  }

  /**
   * Force-remove a single worktree + its branch (best-effort, never throws). Used by the
   * pipeline's `finally` so a task that FAILS or throws before `mergeAndCleanup` runs does
   * not orphan its worktree. (A process kill can't run this — {@link reapOrphans} is the
   * next-boot / next-dispatch catch-all for that.)
   */
  async remove(worktreePath: string, branch: string, originalCwd: string): Promise<void> {
    await this.exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: originalCwd, windowsHide: true })
      .catch(() => this.fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined));
    await this.exec('git', ['worktree', 'prune'], { cwd: originalCwd, windowsHide: true }).catch(() => undefined);
    if (branch) {
      await this.exec('git', ['branch', '-D', branch], { cwd: originalCwd, windowsHide: true }).catch(() => undefined);
    }
  }

  /**
   * Reap worktrees under `<cwd>/.mma/worktrees/` left behind by tasks that are no longer
   * in flight — the catch-all for worktrees orphaned by a process kill (tsx-restart /
   * SIGKILL) that could not run their own cleanup. `isActive(shortId)` returns true when a
   * live task still owns that worktree dir (wired to the task registry at dispatch time), so
   * concurrently-running tasks are never touched. Best-effort; returns the count reaped.
   */
  async reapOrphans(cwd: string, isActive: (shortId: string) => boolean): Promise<number> {
    if (!(await this.isGitRepo(cwd))) return 0;
    const worktreesDir = join(cwd, '.mma', 'worktrees');
    let entries: string[];
    try {
      entries = await this.fs.readdir(worktreesDir);
    } catch {
      return 0; // no worktrees dir yet — nothing to reap
    }
    // Drop git's registrations for dirs already gone, then read the mma/* branch list once.
    await this.exec('git', ['worktree', 'prune'], { cwd, windowsHide: true }).catch(() => undefined);
    const { stdout } = await this.exec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/mma/'], { cwd, windowsHide: true })
      .catch(() => ({ stdout: '', stderr: '' }));
    const mmaBranches = stdout.split('\n').map((s) => s.trim()).filter(Boolean);

    let reaped = 0;
    for (const shortId of entries) {
      if (isActive(shortId)) continue; // a live task still owns this worktree — never touch it
      const wtPath = join(worktreesDir, shortId);
      await this.exec('git', ['worktree', 'remove', '--force', wtPath], { cwd, windowsHide: true })
        .catch(() => this.fs.rm(wtPath, { recursive: true, force: true }).catch(() => undefined));
      for (const br of mmaBranches) {
        if (br.endsWith(`-${shortId}`)) {
          await this.exec('git', ['branch', '-D', br], { cwd, windowsHide: true }).catch(() => undefined);
        }
      }
      reaped++;
    }
    if (reaped > 0) {
      await this.exec('git', ['worktree', 'prune'], { cwd, windowsHide: true }).catch(() => undefined);
    }
    return reaped;
  }

  /**
   * Merge worktree branch back into the original branch, remove worktree, delete branch.
   * Returns the merge result. On merge conflict, preserves the worktree for manual resolution.
   */
  async mergeAndCleanup(worktreePath: string, branch: string, originalCwd: string, commitMessage?: string): Promise<WorktreeInfo> {
    // In-place execution (non-git target): create() returned an empty branch with the worktree
    // path equal to the original cwd. There is no worktree or branch to merge or clean up — no-op.
    if (branch === '' && worktreePath === originalCwd) {
      return { branch: '', path: originalCwd, hasChanges: false, merged: false };
    }

    // Defensive: if the worktree directory is gone (e.g. an OS temp-dir reap, or
    // an agent that deleted it), every `git` spawn with `cwd: worktreePath` would
    // throw `spawn git ENOENT` and crash the whole pipeline. Detect it first and
    // degrade gracefully — prune the stale registration + branch from the parent,
    // and report not-merged rather than crashing.
    try {
      await this.fs.access(worktreePath);
    } catch {
      await this.exec('git', ['worktree', 'prune'], { cwd: originalCwd, windowsHide: true }).catch(() => {});
      await this.exec('git', ['branch', '-D', branch], { cwd: originalCwd, windowsHide: true }).catch(() => {});
      return { branch, path: worktreePath, hasChanges: false, merged: false };
    }

    const dirty = await this.hasChanges(worktreePath);

    if (!dirty) {
      // No changes — just remove worktree + branch
      await this.gitWithRetry(['worktree', 'remove', worktreePath, '--force'], { cwd: originalCwd, windowsHide: true });
      await this.gitWithRetry(['branch', '-D', branch], { cwd: originalCwd, windowsHide: true });
      // Clean up empty parent directories
      try {
        const worktreesDir = dirname(worktreePath);
        const entries = await readdir(worktreesDir);
        if (entries.length === 0) {
          await rmdir(worktreesDir);
          const mmaDir = dirname(worktreesDir);
          const mmaEntries = await readdir(mmaDir);
          if (mmaEntries.length === 0) await rmdir(mmaDir);
        }
      } catch { /* best-effort */ }
      return { branch, path: worktreePath, hasChanges: false, merged: false };
    }

    // Commit any uncommitted changes in the worktree
    await this.exec('git', ['add', '-A'], { cwd: worktreePath, windowsHide: true });
    try {
      await this.exec('git', ['commit', '-m', commitMessage ?? `[mma] auto-commit before merge`], { cwd: worktreePath, windowsHide: true });
    } catch {
      // Already committed or nothing to commit
    }

    // Compute filesChanged BEFORE the merge, as the full diff of the worktree branch against its
    // fork point (merge-base with the current target). This is robust to (a) concurrent merges
    // advancing the shared HEAD between merge and diff, and (b) the worker making its own commits —
    // a post-merge `HEAD~1..HEAD` would miss both. merge-base is the stable fork point regardless of
    // how the target branch moved.
    let filesChanged: string[] = [];
    try {
      const { stdout: base } = await this.exec('git', ['merge-base', branch, 'HEAD'], { cwd: originalCwd, windowsHide: true });
      const { stdout } = await this.exec('git', ['diff', '--name-only', base.trim(), branch], { cwd: originalCwd, windowsHide: true });
      filesChanged = stdout.trim().split('\n').filter(Boolean);
    } catch { /* best-effort — empty list on failure */ }

    // Merge worktree branch into original branch — prefer fast-forward for linear history.
    // If the target moved while the worker ran, rebase the worktree branch first.
    try {
      await this.exec('git', ['merge', '--ff-only', branch], { cwd: originalCwd, windowsHide: true });
    } catch {
      // Fast-forward failed — target branch moved. Rebase worktree onto target, then retry ff.
      try {
        await this.exec('git', ['rebase', 'HEAD', branch], { cwd: originalCwd, windowsHide: true });
        await this.exec('git', ['merge', '--ff-only', branch], { cwd: originalCwd, windowsHide: true });
      } catch {
        // Rebase conflict — preserve worktree for manual resolution
        await this.exec('git', ['rebase', '--abort'], { cwd: originalCwd, windowsHide: true }).catch(() => {});
        return { branch, path: worktreePath, hasChanges: true, merged: false };
      }
    }

    // Merge succeeded — remove worktree + branch (shared `.git` registry → retry on lock)
    await this.gitWithRetry(['worktree', 'remove', worktreePath, '--force'], { cwd: originalCwd, windowsHide: true });
    await this.gitWithRetry(['branch', '-D', branch], { cwd: originalCwd, windowsHide: true });

    // Clean up empty parent directories (.mma/worktrees/, .mma/)
    try {
      const worktreesDir = dirname(worktreePath);
      const entries = await readdir(worktreesDir);
      if (entries.length === 0) {
        await rmdir(worktreesDir);
        const mmaDir = dirname(worktreesDir);
        const mmaEntries = await readdir(mmaDir);
        if (mmaEntries.length === 0) await rmdir(mmaDir);
      }
    } catch { /* best-effort */ }

    return { branch, path: worktreePath, hasChanges: true, merged: true, filesChanged };
  }

}
