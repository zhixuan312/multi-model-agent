// Stage I/O standardization — commitHandler emits StageGate<CommitPayload>.
//
// Gate logic per the spec:
//   no_repo, no_diff, validation_failed, validation_stale, hook_failed

// DEBUG: SOURCE FILE LOADED AT $(date)
//
// The spec (Step 13) supersedes the v4.4.x behavior:
//   - Returns StageGate<CommitPayload> (tagged union { committed | no_op })
//   - Detached HEAD maps to kind: 'no_op', reason: 'no_repo'
//   - Commit message includes 'rework left N findings unaddressed' annotation
//     when applicable
//   - Does NOT mutate state.lastRunResult or state.commits (those are retired from active use).
//   - Downstream consumers (annotate-parser, annotate-prompts, seal handler) read state.gates.commit.payload.kind
//     directly via deriveCompletion() — the legacy state.commits[] mirror is dead.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, CommitPayload } from '../stage-io.js';
import { withRepoCommitLock } from '../repo-commit-lock.js';
import { resolveGitToplevel } from '../git-toplevel.js';
import { composeCommitMessage } from './compose-commit-message.js';

const execFileP = promisify(execFile);

/**
 * The files THIS worker actually wrote, resolved to absolute paths inside cwd.
 *
 * Source is the harness-tracked tool writes (lastRunResult.filesWritten — unioned
 * across implement+rework by replaceLastRunResultPreservingTrackers), NOT a
 * repo-wide `git diff`. Under concurrency (multiple workers in the same repo at
 * once) a git diff would see every worker's changes; sourcing from this worker's
 * own tracked writes guarantees we commit only its own work. Paths the worker
 * passed that fall outside cwd or never landed on disk (e.g. a hallucinated
 * `/workspace/x` or `/x`) are dropped.
 */
function workerWrittenFiles(state: LifecycleState, cwd: string): string[] {
  const raw = ((state.lastRunResult as { filesWritten?: string[] } | undefined)?.filesWritten) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of raw) {
    if (!w || typeof w !== 'string') continue;
    const abs = isAbsolute(w) ? w : join(cwd, w);
    const rel = relative(cwd, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue; // outside cwd
    if (!existsSync(abs)) continue; // bogus path or never written
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

async function gitC(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
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

async function isInsideWorkTree(cwd: string): Promise<boolean> {
  const r = await gitC(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function currentHead(cwd: string): Promise<string | null> {
  const r = await gitC(cwd, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

// ─── Payload helpers ─────────────────────────────────────────────────────────

function advanceNoOp(
  reason: 'no_repo' | 'no_diff' | 'hook_failed',
  t0: number,
  detail?: string,
): StageGate<CommitPayload> {
  return {
    outcome: 'advance',
    payload: { kind: 'no_op', reason, detail },
    telemetry: {
      stageLabel: 'committing',
      durationMs: Date.now() - t0,
      costUSD: 0,
      turnsUsed: 0,
      stopReason: 'normal',
    },
  };
}

function haltCommit(comment: string, t0: number): StageGate<CommitPayload> {
  return {
    outcome: 'halt',
    comment,
    payload: { kind: 'no_op', reason: 'no_diff' }, // placeholder; halt path
    telemetry: {
      stageLabel: 'committing',
      durationMs: Date.now() - t0,
      costUSD: 0,
      turnsUsed: 0,
      stopReason: 'transport_error',
    },
  };
}


function isHookFailure(err: unknown): boolean {
  if (err instanceof Error) {
    return /pre-commit hook|hook failed|hook rejected/i.test(err.message);
  }
  // gitC result shape: { code, stdout, stderr }
  if (typeof err === 'object' && err !== null) {
    const r = err as { code?: number; stderr?: string; stdout?: string };
    const text = `${r.stderr ?? ''} ${r.stdout ?? ''}`;
    return /pre-commit hook|hook failed|hook rejected|hook script|\.git\/hooks\//i.test(text);
  }
  return false;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function commitHandler(state: LifecycleState): Promise<StageGate<CommitPayload>> {
  const t0 = Date.now();

  const cwd = (state.cwd as string | undefined) ?? (state.executionContext as { cwd?: string } | undefined)?.cwd;
  if (!cwd) {
    return advanceNoOp('no_repo', t0, 'no cwd available');
  }

  // Gate 1: no_repo
  if (!await isInsideWorkTree(cwd)) {
    return advanceNoOp('no_repo', t0);
  }

  // Gate 2: detached HEAD / no branch → no_repo
  const head = await currentHead(cwd);
  if (!head) {
    return advanceNoOp('no_repo', t0, 'detached HEAD or no branch');
  }

  // Concurrency-safe attribution: commit ONLY the files THIS worker wrote,
  // resolved to cwd from the harness-tracked tool writes. A repo-wide git diff
  // would, under concurrent same-repo tasks, sweep in other workers' changes.
  const ownFiles = workerWrittenFiles(state, cwd);
  if (ownFiles.length === 0) {
    return advanceNoOp('no_diff', t0);
  }
  const filesChanged = ownFiles;

  // Per-repo commit mutex: serialize the staging+commit section against any
  // other worker committing to the SAME repo so concurrent same-repo tasks
  // never collide on `.git/index.lock`. Distinct repos run concurrently.
  // Read-only probes above (worktree check, HEAD) run outside the lock.
  const repoKey = (await resolveGitToplevel(cwd)) ?? cwd;
  return withRepoCommitLock(repoKey, async (): Promise<StageGate<CommitPayload>> => {
    // Stage ONLY this worker's files.
    const addR = await gitC(cwd, ['add', '--', ...ownFiles]);
    if (addR.code !== 0) {
      return advanceNoOp('hook_failed', t0, addR.stderr || 'git add failed');
    }

    // Confirm THESE paths have staged changes (scoped — ignores anything a
    // concurrent worker may have staged). Exits 0 when nothing staged for them.
    const diffR = await gitC(cwd, ['diff', '--cached', '--quiet', '--', ...ownFiles]);
    if (diffR.code === 0) {
      return advanceNoOp('no_diff', t0);
    }

    const commitMessage = composeCommitMessage(state, filesChanged, cwd);

    try {
      // Pathspec-scoped commit: commits ONLY ownFiles, even if a concurrent
      // worker has other paths staged in the same index.
      const commitR = await gitC(cwd, ['commit', '-m', commitMessage, '--', ...ownFiles]);
      if (commitR.code !== 0) {
        // Hook failure is the dominant case: we've already validated repo,
        // diff, and HEAD; if `git commit` still fails, the most likely cause
        // is a pre-commit hook (or other policy hook) rejecting the commit.
        // We treat non-zero exit as hook_failed unless the stderr indicates
        // something structurally worse (corrupted index, fs errors).
        const stderr = commitR.stderr ?? '';
        const looksStructural = /index|object|corrupt|permission denied|read-only/i.test(stderr);
        if (!looksStructural) {
          return advanceNoOp('hook_failed', t0, stderr || 'commit rejected (likely pre-commit hook)');
        }
        return haltCommit(`commit_failed: ${stderr || 'unknown error'}`, t0);
      }
      const sha = (await currentHead(cwd)) ?? '';
      const authoredAt = new Date().toISOString();
      return {
        outcome: 'advance',
        payload: {
          kind: 'committed',
          commitSha: sha,
          commitMessage,
          filesChanged,
          authoredAt,
        },
        telemetry: {
          stageLabel: 'committing',
          durationMs: Date.now() - t0,
          costUSD: 0,
          turnsUsed: 0,
          stopReason: 'normal',
        },
      };
    } catch (err) {
      if (isHookFailure(err)) {
        return advanceNoOp('hook_failed', t0, err instanceof Error ? err.message : String(err));
      }
      return haltCommit(`commit_failed: ${err instanceof Error ? err.message : String(err)}`, t0);
    }
  });
}