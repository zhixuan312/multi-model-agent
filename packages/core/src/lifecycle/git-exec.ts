import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a git subcommand in `cwd`. Never throws — a non-zero exit (or spawn
 * failure) is returned as `{ code, stderr }`. Shared by the goal-set executor
 * (preconditions, baseSha capture, git-log report) so git plumbing lives in one
 * place rather than inline in a handler.
 */
export async function gitC(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, ...args], { windowsHide: true });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** True when `cwd` is inside a git work-tree. */
export async function isInsideWorkTree(cwd: string): Promise<boolean> {
  const r = await gitC(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** Resolved HEAD sha, or null when HEAD is unborn / unresolvable. */
export async function currentHead(cwd: string): Promise<string | null> {
  const r = await gitC(cwd, ['rev-parse', 'HEAD']);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * True when the work-tree has no uncommitted changes (tracked or untracked).
 * Uses `git status --porcelain` — empty output means clean.
 */
export async function isCleanWorkTree(cwd: string): Promise<boolean> {
  const r = await gitC(cwd, ['status', '--porcelain']);
  return r.code === 0 && r.stdout.trim() === '';
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  const r = await gitC(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return r.code === 0;
}

/** Number of commits in `base..HEAD` (0 when none / base unresolved). */
export async function commitCount(cwd: string, base: string): Promise<number> {
  const r = await gitC(cwd, ['rev-list', '--count', `${base}..HEAD`]);
  if (r.code !== 0) return 0;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export interface GitLogCommit {
  sha: string;
  subject: string;
  filesChanged: string[];
}

/**
 * Structured commit list for `base..HEAD`, oldest-first. Subjects + changed
 * files only (no patch bodies) so the payload stays bounded — see the spec's
 * git-log-format note. Returns [] when base is unresolved or there are none.
 */
export async function gitLogCommits(cwd: string, base: string): Promise<GitLogCommit[]> {
  // %x00 record sep, %x1e field sep: sha, subject. Then --name-only file lines.
  const r = await gitC(cwd, [
    'log', '--reverse', '--name-only', '--no-color',
    '--pretty=format:%x1e%H%x1f%s', `${base}..HEAD`,
  ]);
  if (r.code !== 0 || r.stdout.trim() === '') return [];
  const commits: GitLogCommit[] = [];
  const records = r.stdout.split('\x1e').filter((s) => s.length > 0);
  for (const rec of records) {
    const nlIdx = rec.indexOf('\n');
    const header = nlIdx === -1 ? rec : rec.slice(0, nlIdx);
    const [sha, subject] = header.split('\x1f');
    const fileBlock = nlIdx === -1 ? '' : rec.slice(nlIdx + 1);
    const filesChanged = fileBlock.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    commits.push({ sha: (sha ?? '').trim(), subject: (subject ?? '').trim(), filesChanged });
  }
  return commits;
}

/**
 * Render `base..HEAD` as `git log --stat`-style text for the phase-2 handoff,
 * truncated to `maxBytes` with a marker. Subjects + per-commit file lists, no
 * patch body.
 */
export async function renderGitLogStat(cwd: string, base: string, maxBytes = 128 * 1024): Promise<{ text: string; truncated: boolean }> {
  const r = await gitC(cwd, ['log', '--stat', '--no-patch', '--no-color', `${base}..HEAD`]);
  const full = r.code === 0 ? r.stdout : '';
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return { text: full, truncated: false };
  // Truncate on a UTF-8-safe boundary.
  const buf = Buffer.from(full, 'utf8').subarray(0, maxBytes);
  return { text: buf.toString('utf8') + '\n…[git_log_truncated]…\n', truncated: true };
}

/**
 * Ensure a committer identity is resolvable for the agent's own `git commit`
 * calls. The agent commits in its own subprocess, so env overrides won't reach
 * it — instead, when the repo/global config has no identity, set a goal-set
 * identity in the **local repo config** so the agent's commits inherit it.
 * Returns true when it set one, false when an identity already existed.
 */
export async function ensureGitIdentity(cwd: string, goalId: string): Promise<boolean> {
  const name = await gitC(cwd, ['config', 'user.name']);
  const email = await gitC(cwd, ['config', 'user.email']);
  if (name.code === 0 && name.stdout.trim() && email.code === 0 && email.stdout.trim()) return false;
  await gitC(cwd, ['config', 'user.name', `MMA Goal ${goalId}`]);
  await gitC(cwd, ['config', 'user.email', 'noreply@mmagent.local']);
  return true;
}
