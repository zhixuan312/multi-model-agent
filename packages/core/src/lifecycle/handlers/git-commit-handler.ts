// Stage I/O standardization — commitHandler emits StageGate<CommitPayload>.
//
// Gate logic per the spec:
//   no_repo, no_diff, validation_failed, validation_stale,
//   worker_committed_out_of_band, hook_failed

// DEBUG: SOURCE FILE LOADED AT $(date)
//
// The spec (Step 13) supersedes the v4.4.x behavior:
//   - Returns StageGate<CommitPayload> (tagged union { committed | no_op })
//   - Detached HEAD maps to kind: 'no_op', reason: 'no_repo'
//   - Commit message includes 'rework left N findings unaddressed' annotation
//     when applicable
//   - Does NOT mutate state.lastRunResult or state.commits (those are retired
//     from the new chain; compose reads state.gates instead)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, CommitPayload } from '../stage-io.js';
import { getRealFilesChanged } from '../real-diff.js';

const execFileP = promisify(execFile);

async function gitC(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, ...args]);
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
  reason: 'no_repo' | 'no_diff' | 'worker_committed_out_of_band' | 'hook_failed',
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

function composeCommitMessage(state: LifecycleState): string {
  const summary =
    (state.gates?.['rework']?.payload as { summary?: string } | undefined)?.summary ??
    (state.gates?.['implement']?.payload as { summary?: string } | undefined)?.summary ??
    '(no summary)';
  const firstLine = summary.split('\n')[0].slice(0, 72);
  const reviewVerdict = (state.gates?.['review']?.payload as { verdict?: string } | undefined)?.verdict;
  const unaddressed = (
    (state.gates?.['rework']?.payload as { unaddressedFindingIds?: string[] } | undefined)?.unaddressedFindingIds ??
    []
  );

  let msg = `implement: ${firstLine}\n\n${summary}`;
  if (reviewVerdict === 'changes_required' && unaddressed.length > 0) {
    msg += `\n\nRework left ${unaddressed.length} findings unaddressed: ${unaddressed.join(', ')}.`;
  }
  return msg;
}

function isHookFailure(err: unknown): boolean {
  return err instanceof Error && /pre-commit hook|hook failed/i.test(err.message);
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

  // Use the existing getRealFilesChanged() helper (lifecycle/real-diff.ts).
  // Reconciliation: plan said `realChange.method === 'git_error'`; the actual
  // field on RealFilesChanged is `realChange.source === 'git_error'`.
  const realChange = await getRealFilesChanged(state);
  if (realChange.source === 'git_error' || realChange.files.length === 0) {
    return advanceNoOp('no_diff', t0);
  }
  const filesChanged = realChange.files;

  // Gate 3: worker out-of-band commit detection
  const preSha = (state as { preTaskHeadSha?: string }).preTaskHeadSha;
  if (preSha && head !== preSha && realChange.source === 'self_report') {
    return advanceNoOp('worker_committed_out_of_band', t0);
  }

  // Stage: git add
  // Always run `git add` on the files we know about from getRealFilesChanged.
  // If getRealFilesChanged returned empty (no preTaskHeadSha/preTaskUntrackedFiles),
  // fall back to staging the files the worker reported. This ensures untracked
  // files are staged so `git diff --cached` can detect them.
  const filesToStage = filesChanged.length > 0 ? filesChanged : (
    ((state.lastRunResult as { filesChanged?: string[] } | undefined)?.filesChanged) ?? []
  );
  if (filesToStage.length === 0) {
    return advanceNoOp('no_diff', t0);
  }
  const addR = await gitC(cwd, ['add', '--', ...filesToStage]);
  if (addR.code !== 0) {
    return advanceNoOp('hook_failed', t0, addR.stderr || 'git add failed');
  }

  // Post-stage: confirm staged diff is non-empty.
  // `git diff --cached --quiet` exits 0 when nothing is staged; 1 when staged.
  const diffR = await gitC(cwd, ['diff', '--cached', '--quiet', '--', '.']);
  if (diffR.code === 0) {
    return advanceNoOp('no_diff', t0);
  }

  const commitMessage = composeCommitMessage(state);

  try {
    const commitR = await gitC(cwd, ['commit', '-m', commitMessage]);
    if (commitR.code !== 0) {
      if (isHookFailure(commitR)) {
        return advanceNoOp('hook_failed', t0, commitR.stderr || 'hook rejected commit');
      }
      return haltCommit(`commit_failed: ${commitR.stderr || 'unknown error'}`, t0);
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
}

// ─── Exports (backwards compatibility alias) ─────────────────────────────────
// The old export name from v4.4.x; new code should use commitHandler.
export { commitHandler as gitCommitHandler };