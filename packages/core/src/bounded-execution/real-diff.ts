// Sub-project A: filesChanged from real `git diff`, not worker self-report.
//
// Three sources, with explicit discriminator:
// - `git_diff`   — Authoritative. Used for commit decisions, telemetry counts,
//                  watchdog signals.
// - `self_report` — Non-git cwd. Used for telemetry counts ONLY. Watchdog
//                  signals 1, 2, 3 are all DISABLED in this mode.
// - `git_error`  — Git work-tree exists but a git invocation failed. `files`
//                  is the empty array; nothing is fabricated from self-report.
//                  Commit handler treats as `no_diff` and skips.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface RealFilesChanged {
  files: string[];
  source: 'git_diff' | 'self_report' | 'git_error';
}

/** Structural subset of LifecycleState that getRealFilesChanged reads. Declared
 *  here so this substrate-layer git primitive carries no dependency on the
 *  lifecycle/pipeline layer (enforced by .dependency-cruiser.cjs's
 *  no-substrate-to-pipeline rule). LifecycleState satisfies it structurally. */
export interface RealDiffInputs {
  cwd?: string;
  executionContext?: unknown;
  preTaskHeadSha?: string;
  preTaskUntrackedFiles?: Set<string>;
  lastRunResult?: unknown;
}

export async function getRealFilesChanged(state: RealDiffInputs): Promise<RealFilesChanged> {
  // Defense in depth: prefer state.cwd, fall back to executionContext.cwd —
  // production wires it on the latter. Without this the helper goes inert
  // (self_report) and the git-truth safety net never engages.
  const cwd = state.cwd ?? (state.executionContext as { cwd?: string } | undefined)?.cwd;
  const preSha = state.preTaskHeadSha;
  const preUntracked = state.preTaskUntrackedFiles;

  if (!cwd || !preSha || !preUntracked) {
    const selfReport =
      ((state.lastRunResult as { filesChanged?: string[] } | undefined)?.filesChanged) ?? [];
    return { files: selfReport, source: 'self_report' };
  }

  try {
    // `git diff <sha>` (no `..`) compares working tree to <sha>. Includes both
    // staged and unstaged changes — what we want for "files touched since task
    // entry". `git diff <sha>..` (with `..`) would only diff committed changes.
    const diffResult = spawnSync('git', ['diff', '--name-only', preSha], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (diffResult.status !== 0) {
      return { files: [], source: 'git_error' };
    }
    const diffFiles = diffResult.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((rel) => join(cwd, rel));

    const lsResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (lsResult.status !== 0) {
      return { files: [], source: 'git_error' };
    }
    const currentUntracked = lsResult.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((rel) => join(cwd, rel));
    const newUntracked = currentUntracked.filter((p) => !preUntracked.has(p));

    return { files: [...diffFiles, ...newUntracked], source: 'git_diff' };
  } catch {
    return { files: [], source: 'git_error' };
  }
}
