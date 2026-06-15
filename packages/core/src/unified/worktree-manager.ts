import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFileCb);

export interface WorktreeInfo {
  branch: string;
  path: string;
  hasChanges: boolean;
  merged: boolean;
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

export class WorktreeManager {
  private readonly exec: ExecFn;
  private readonly fs: FsOps;

  constructor(exec?: ExecFn, fs?: FsOps) {
    this.exec = exec ?? defaultExec;
    this.fs = fs ?? defaultFs;
  }

  async create(cwd: string, taskId: string, type: string): Promise<WorktreeInfo> {
    const shortId = taskId.slice(0, 8);
    const branch = `mma/${type}-${shortId}`;
    const worktreeDir = join(cwd, '.mma', 'worktrees', shortId);

    await this.fs.mkdir(join(cwd, '.mma', 'worktrees'), { recursive: true });
    await this.exec('git', ['worktree', 'add', worktreeDir, '-b', branch], { cwd, windowsHide: true });

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
  async mergeAndCleanup(worktreePath: string, branch: string, originalCwd: string): Promise<WorktreeInfo> {
    const dirty = await this.hasChanges(worktreePath);

    if (!dirty) {
      // No changes — just remove worktree + branch
      await this.exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: worktreePath, windowsHide: true });
      await this.exec('git', ['branch', '-D', branch], { cwd: originalCwd, windowsHide: true });
      return { branch, path: worktreePath, hasChanges: false, merged: false };
    }

    // Commit any uncommitted changes in the worktree
    await this.exec('git', ['add', '-A'], { cwd: worktreePath, windowsHide: true });
    try {
      await this.exec('git', ['commit', '-m', `[mma] auto-commit before merge`], { cwd: worktreePath, windowsHide: true });
    } catch {
      // Already committed or nothing to commit
    }

    // Merge worktree branch into original branch from the main cwd
    try {
      await this.exec('git', ['merge', branch, '--no-edit'], { cwd: originalCwd, windowsHide: true });
    } catch {
      // Merge conflict — preserve worktree for manual resolution
      await this.exec('git', ['merge', '--abort'], { cwd: originalCwd, windowsHide: true }).catch(() => {});
      return { branch, path: worktreePath, hasChanges: true, merged: false };
    }

    // Merge succeeded — remove worktree + branch
    await this.exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: originalCwd, windowsHide: true });
    await this.exec('git', ['branch', '-D', branch], { cwd: originalCwd, windowsHide: true });
    return { branch, path: worktreePath, hasChanges: true, merged: true };
  }

  async getInfo(worktreePath: string, branch: string): Promise<WorktreeInfo> {
    const dirty = await this.hasChanges(worktreePath);
    return { branch, path: worktreePath, hasChanges: dirty, merged: false };
  }
}
