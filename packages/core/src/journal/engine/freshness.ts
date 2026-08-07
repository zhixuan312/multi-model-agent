import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Sublinear repository freshness detection.
 *
 * Journal learning 0084: a derived index loses its value when the freshness
 * check that protects it costs more than the read it protects. Historically,
 * journal retrieval `fs.stat`'d every markdown node before every query — an
 * O(corpus) cost on every read. This module exists so the repository file
 * corpus (`../adapters/file-adapter.ts`) never repeats that mistake: when the
 * corpus root is a git worktree, `git status --porcelain` reports exactly
 * what changed since the last commit/index in one subprocess call — time
 * proportional to what CHANGED, not to corpus size, because git answers from
 * its own cached index rather than this process issuing one `fs.stat` per
 * file. Only when the root is not a git repository do we fall back to a full
 * stat sweep, and that fallback is explicitly throttled by the caller
 * (`CorpusIndex.ensureFreshSymbols`) so it cannot run on every query either.
 */

const execFileAsync = promisify(execFile);

/** Changed and deleted paths (repository-relative, POSIX separators) since git's last known state. */
export interface GitChangeSet {
  /** Full git-tracked corpus file set, obtained from git's index without an fs.stat sweep. */
  trackedPaths: string[];
  changedPaths: string[];
  deletedPaths: string[];
}

/**
 * Split raw NUL-delimited git output (the `-z` flag) into path tokens. `-z`
 * disables git's C-style quoting/octal-escaping of filenames entirely — the
 * reason {@link detectGitChanges} uses it instead of newline-delimited output
 * plus manual quote/escape decoding, which historically left Unicode or
 * control-character filenames indexed under their escaped text (or missed
 * entirely). Only the trailing empty token after the final NUL needs dropping.
 */
function splitNulDelimited(raw: string): string[] {
  return raw.split('\0').filter((token) => token.length > 0);
}

/**
 * Detect changed/deleted files via `git status --porcelain -z`, without ever
 * `fs.stat`-ing the whole corpus from this process. Returns `null` when
 * `root` is not inside a git work tree, or the git invocation otherwise
 * fails — callers treat `null` as "use the throttled non-git fallback",
 * never as a hard error (a missing/broken git binary must not fail search).
 *
 * `opts.includeTracked` also runs `git ls-files -z` to populate
 * {@link GitChangeSet.trackedPaths} — needed only to seed a genuinely EMPTY
 * index (see `CorpusIndex.ensureFreshSymbols`), where `git status` alone (which
 * reports only what changed since the last commit) would leave an
 * already-committed repository's first-time index empty forever. Every other
 * call is steady state and must cost exactly ONE subprocess call: defaults to
 * `false`, running `git status` alone.
 */
export async function detectGitChanges(
  root: string,
  opts?: { includeTracked?: boolean },
): Promise<GitChangeSet | null> {
  const includeTracked = opts?.includeTracked ?? false;
  let trackedStdout = '';
  let statusStdout: string;
  try {
    if (includeTracked) {
      const [tracked, status] = await Promise.all([
        execFileAsync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }),
        execFileAsync(
          'git',
          ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'],
          { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        ),
      ]);
      trackedStdout = tracked.stdout;
      statusStdout = status.stdout;
    } else {
      const status = await execFileAsync(
        'git',
        ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      );
      statusStdout = status.stdout;
    }
  } catch {
    return null;
  }

  const trackedPaths = splitNulDelimited(trackedStdout);
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const tokens = splitNulDelimited(statusStdout);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status[0] === 'R' || status[1] === 'R') {
      // Rename: with `-z`, git prints the OLD (pre-rename) path as a SEPARATE
      // NUL-terminated token immediately following this entry — unlike the
      // newline-delimited format's single "R  old -> new" line — so consume
      // one extra token here. Old path is gone, new path needs (re)indexing.
      const oldPath = tokens[i + 1];
      i += 1;
      if (oldPath) deletedPaths.push(oldPath);
      changedPaths.push(path);
      continue;
    }
    if (status[0] === 'D' || status[1] === 'D') {
      deletedPaths.push(path);
    } else {
      changedPaths.push(path);
    }
  }
  return { trackedPaths, changedPaths, deletedPaths };
}

/**
 * Enumerate every git-tracked file under `root` in one subprocess call. Used
 * only by administrative, explicitly-invoked full listings (e.g.
 * `rebuild()`'s adapter file enumeration) — never by the throttled per-query
 * freshness path. Returns `null` under the same "not a git repo, or git
 * failed" conditions as {@link detectGitChanges}.
 */
export async function listGitTrackedFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-z'], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return splitNulDelimited(stdout);
  } catch {
    return null;
  }
}

/** Freshness decision taken on the git path: no corpus-wide stat sweep ever runs. */
export interface GitFreshnessDecision {
  mode: 'git';
  statSweep: false;
  trackedPaths: string[];
  changedPaths: string[];
  deletedPaths: string[];
}

/** Freshness decision taken on the non-git fallback path: a throttled full stat sweep. */
export interface StatFreshnessDecision {
  mode: 'stat';
  /** Whether THIS `ensureFresh()` call actually performed a sweep (vs. was throttled/skipped). */
  statSweep: boolean;
  /** Cumulative number of full sweeps performed by this `CorpusIndex` instance so far. */
  sweepCount: number;
}

export type FreshnessDecision = GitFreshnessDecision | StatFreshnessDecision;
