import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, rmdir, readdir } from 'node:fs/promises';
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
}

const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: opts.cwd, windowsHide: true });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
};

const defaultFs: FsOps = {
  mkdir: async (path, opts) => { await mkdir(path, opts); },
  access: async (path) => { await access(path); },
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

function errText(err: unknown): string {
  return err instanceof Error ? `${err.message} ${(err as { stderr?: string }).stderr ?? ''}` : String(err);
}

function isLockContention(err: unknown): boolean {
  return LOCK_ERROR_RE.test(errText(err));
}

/** `git worktree add` is non-idempotent: a lock-interrupted partial run leaves the
 *  branch/worktree behind, so a blind retry fails "already exists". We clean up and
 *  retry on EITHER signal. */
function isAddRetryable(err: unknown): boolean {
  const msg = errText(err);
  return LOCK_ERROR_RE.test(msg) || /already (exists|checked out|used by worktree)/i.test(msg);
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
   * Run a git command, retrying on transient `.git/config`/ref lock contention so
   * concurrent same-repo worktree ops don't break each other. Up to 8 attempts
   * with linear backoff (~50ms → ~400ms); a non-lock error throws immediately.
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
        if (attempt === maxAttempts || !isLockContention(err)) throw err;
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

  async create(cwd: string, taskId: string, type: string): Promise<WorktreeInfo> {
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
   * Merge worktree branch back into the original branch, remove worktree, delete branch.
   * Returns the merge result. On merge conflict, preserves the worktree for manual resolution.
   */
  async mergeAndCleanup(worktreePath: string, branch: string, originalCwd: string, commitMessage?: string): Promise<WorktreeInfo> {
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
      await this.gitWithRetry(['worktree', 'remove', worktreePath, '--force'], { cwd: worktreePath, windowsHide: true });
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

    // Compute filesChanged from the merge commit (source of truth, not tool-call tracking)
    let filesChanged: string[] = [];
    try {
      const { stdout } = await this.exec('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: originalCwd, windowsHide: true });
      filesChanged = stdout.trim().split('\n').filter(Boolean);
    } catch { /* best-effort — empty list on failure */ }

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
