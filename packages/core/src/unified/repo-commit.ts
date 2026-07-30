import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Engine-owned git for in-place write routes.
 *
 * The caller owns the branch — `/mma:flow`, a Forge project, or a Forge loop has already cut
 * and checked out `mma/<date>-<slug>` before dispatching. The engine never creates a branch or
 * a worktree; it edits the caller's checkout in place and commits there.
 *
 * Everything here runs in the DAEMON process via execFile, outside every worker sandbox. That
 * separation is what lets workers be denied git entirely while commits still happen: the worker
 * only ever edits files.
 */

export interface RepoBaseline {
  /** HEAD before the worker ran. `null` for a non-git target. */
  readonly head: string | null;
  /** The branch the CALLER checked out. Committing anywhere else would be a silent mis-delivery. */
  readonly branch: string | null;
  /** FR-4: `git status --porcelain` was non-empty before dispatch. `false` for a non-git target. */
  readonly dirtyAtDispatch: boolean;
  /** Exact `git status --porcelain` text at dispatch. Used to prove the worker actually changed
   *  something before we commit — see {@link commitAll}. */
  readonly statusText: string;
}

export interface CommitOutcome {
  /** True when a new commit was created (false when there was nothing to commit). */
  readonly committed: boolean;
  /** HEAD after the attempt — unchanged from the baseline when nothing was committed. */
  readonly head: string | null;
  /** FR-3: `git diff --name-only <baseline>..HEAD`. Empty when nothing was committed. */
  readonly filesChanged: string[];
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

/** A `.git` ENTRY check — a directory in a normal checkout, a file in a linked worktree. Both
 *  count, because a caller (Forge loops) may legitimately hand us its own worktree as the cwd. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the pre-dispatch baseline. Per the spec's constraint, a git target that cannot yield a
 * HEAD must fail BEFORE a worker starts rather than run without a diff baseline — the caller
 * signals that by receiving a thrown error here.
 */
export async function captureBaseline(cwd: string): Promise<RepoBaseline> {
  if (!(await isGitRepo(cwd))) return { head: null, branch: null, dirtyAtDispatch: false, statusText: '' };

  const head = await git(cwd, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    throw new Error(
      `Cannot capture git HEAD baseline in ${cwd}: ${head.stderr.trim() || 'git rev-parse HEAD failed'}. `
      + 'Refusing to dispatch a write route without a diff baseline.',
    );
  }

  const status = await git(cwd, ['status', '--porcelain']);
  if (status.code !== 0) {
    throw new Error(`Cannot read git status in ${cwd}: ${status.stderr.trim() || 'git status failed'}`);
  }

  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

  return {
    head: head.stdout.trim(),
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    dirtyAtDispatch: status.stdout.trim().length > 0,
    statusText: status.stdout,
  };
}

/**
 * Cross-runner tamper detection, checked after the worker turn and BEFORE the engine commits.
 *
 * Claude's confinement hook can refuse a mutating `git` command outright. Codex runs under a
 * native OS sandbox with no per-command interception, so prevention is not available there and
 * claiming otherwise would be false assurance. What IS available on every runner is detection:
 * the engine recorded HEAD and the branch before dispatch and can simply check they still hold.
 *
 * A moved HEAD or a switched branch means the worker ran git despite being told not to. Failing
 * loudly here is essential — committing onto a branch the caller did not select, or on top of a
 * worker's own rewrite, would silently mis-deliver the work.
 */
export async function assertRepoUntampered(cwd: string, baseline: RepoBaseline): Promise<void> {
  if (baseline.head === null) return;

  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.code === 0 && baseline.branch !== null && branch.stdout.trim() !== baseline.branch) {
    throw new Error(
      `Worker changed the checked-out branch: expected "${baseline.branch}", found "${branch.stdout.trim()}". `
      + 'Refusing to commit. Workers must not run git — the engine owns the commit. Your edits are preserved on disk.',
    );
  }

  const head = await git(cwd, ['rev-parse', 'HEAD']);
  if (head.code === 0 && head.stdout.trim() !== baseline.head) {
    throw new Error(
      `Worker moved HEAD during the task: expected ${baseline.head.slice(0, 12)}, found ${head.stdout.trim().slice(0, 12)}. `
      + 'A worker committed, reset, or rebased despite git being denied. Refusing to commit on top of it — '
      + 'inspect with `git log` and `git status`; nothing has been discarded.',
    );
  }
}

/**
 * Stage everything and commit on whatever branch the caller checked out.
 *
 * `git add -A` is intentional and specified: the branch belongs to this task, so pre-existing
 * and concurrent working-tree changes are swept in deliberately. `dirtyAtDispatch` is what
 * discloses that to the caller. Ignored files stay excluded — `add -A` does not stage untracked
 * paths matched by `.gitignore`.
 *
 * A commit failure must never destroy work: we never reset, checkout, or clean. Edits stay on
 * disk for `git status` and manual recovery, and the error propagates.
 */
export async function commitAll(cwd: string, baseline: RepoBaseline, message: string): Promise<CommitOutcome> {
  if (baseline.head === null) return { committed: false, head: null, filesChanged: [] };

  // Prove the worker actually changed something before committing anything.
  //
  // FR-2 says a commit sweeps the whole tree, which is right when a task DID work: the branch
  // belongs to the task. But it says nothing about a task that changed NOTHING, and for that
  // case sweeping is pure downside — it manufactures a commit out of whatever the caller
  // happened to have in progress. This is not hypothetical: it happened in this repo, where a
  // contract test dispatched a no-op `delegate` against the engine checkout and committed the
  // developer's uncommitted work under the message "[mma] delegate: do something".
  //
  // Comparing the porcelain status against the dispatch baseline is exact: identical text means
  // no file was added, removed, or modified during the turn, so there is nothing of OURS to
  // record and we must leave the caller's tree alone.
  const statusNow = await git(cwd, ['status', '--porcelain']);
  if (statusNow.code === 0 && statusNow.stdout === baseline.statusText) {
    return { committed: false, head: baseline.head, filesChanged: [] };
  }

  const add = await git(cwd, ['add', '-A']);
  if (add.code !== 0) {
    throw new Error(`git add -A failed in ${cwd}: ${add.stderr.trim() || 'unknown error'}. Worker edits are preserved on disk.`);
  }

  const commit = await git(cwd, [
    '-c', 'user.email=mma@localhost',
    '-c', 'user.name=mma worker',
    'commit', '--no-verify', '--no-gpg-sign', '-m', message,
  ]);

  if (commit.code !== 0) {
    // "nothing to commit" is a legitimate no-op, not a failure: a task may correctly change
    // nothing. Anything else is a real error and must surface.
    const combined = `${commit.stdout}\n${commit.stderr}`.toLowerCase();
    const nothingToCommit = combined.includes('nothing to commit')
      || combined.includes('no changes added to commit')
      || combined.includes('working tree clean');
    if (!nothingToCommit) {
      throw new Error(`git commit failed in ${cwd}: ${commit.stderr.trim() || commit.stdout.trim() || 'unknown error'}. Worker edits are preserved on disk.`);
    }
    return { committed: false, head: baseline.head, filesChanged: [] };
  }

  const after = await git(cwd, ['rev-parse', 'HEAD']);
  const head = after.code === 0 ? after.stdout.trim() : baseline.head;

  return { committed: true, head, filesChanged: await filesChangedSince(cwd, baseline.head, head) };
}

/** FR-3 — the frozen evidence command. Never the worker's self-report. */
export async function filesChangedSince(cwd: string, from: string, to = 'HEAD'): Promise<string[]> {
  const diff = await git(cwd, ['diff', '--name-only', `${from}..${to}`]);
  if (diff.code !== 0) return [];
  return diff.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}
