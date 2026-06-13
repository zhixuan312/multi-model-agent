import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFileCb);

export interface WorktreeInfo {
  branch: string;
  path: string;
  hasChanges: boolean;
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

  /**
   * Create a git worktree for a task.
   * Runs `git worktree add` off current HEAD with a task-specific branch.
   * If the worktree has a package.json, runs `pnpm install --frozen-lockfile`.
   */
  async create(cwd: string, taskId: string, type: string): Promise<WorktreeInfo> {
    const shortId = taskId.slice(0, 8);
    const branch = `mma/${type}-${shortId}`;
    const worktreeDir = join(cwd, '.mma', 'worktrees', shortId);

    // Ensure parent dir exists
    await this.fs.mkdir(join(cwd, '.mma', 'worktrees'), { recursive: true });

    // Create worktree with a new branch off HEAD
    await this.exec('git', ['worktree', 'add', worktreeDir, '-b', branch], { cwd, windowsHide: true });

    // Install dependencies if package.json exists
    try {
      await this.fs.access(join(worktreeDir, 'package.json'));
      await this.exec('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreeDir });
    } catch {
      // No package.json — skip install
    }

    return { branch, path: worktreeDir, hasChanges: false };
  }

  /**
   * Check whether a worktree has uncommitted changes.
   */
  async hasChanges(worktreePath: string): Promise<boolean> {
    const { stdout } = await this.exec('git', ['status', '--porcelain'], { cwd: worktreePath, windowsHide: true });
    return stdout.trim().length > 0;
  }

  /**
   * Remove a worktree and its branch if there are no uncommitted changes.
   * Returns true if the worktree was preserved (dirty), false if removed.
   */
  async cleanup(worktreePath: string, branch: string): Promise<boolean> {
    const dirty = await this.hasChanges(worktreePath);
    if (dirty) {
      return true;
    }

    await this.exec('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: worktreePath, windowsHide: true });
    // Branch delete uses the parent repo; worktreePath's parent is fine since
    // the worktree itself was just removed.  Use dirname twice to reach the
    // repo root (.mma/worktrees/<id> → .mma/worktrees → .mma → repo).
    const repoRoot = join(worktreePath, '..', '..', '..');
    await this.exec('git', ['branch', '-D', branch], { cwd: repoRoot, windowsHide: true });
    return false;
  }

  /**
   * Get current info for an existing worktree.
   */
  async getInfo(worktreePath: string, branch: string): Promise<WorktreeInfo> {
    const dirty = await this.hasChanges(worktreePath);
    return { branch, path: worktreePath, hasChanges: dirty };
  }
}
