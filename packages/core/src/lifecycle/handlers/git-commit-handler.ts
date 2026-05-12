// v4.4.x — Committing stage.
//
// Gate logic per the spec:
//   no_repo, no_diff, validation_failed, validation_stale,
//   worker_committed_out_of_band, hook_failed
//
// Worker-supplied commitMessage (from WorkerOutput) is preferred; if
// absent, generate one via a single turn on the standard session
// using the staged diff as input.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Session } from '../../types/run-result.js';
import { mergeStageStats } from '../merge-stage-stats.js';
import { HUMAN_LABEL } from '../stage-labels.js';

const execFileP = promisify(execFile);

export type CommitSkipReason =
  | 'no_repo'
  | 'no_diff'
  | 'validation_failed'
  | 'validation_stale'
  | 'worker_committed_out_of_band'
  | 'hook_failed';

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

function setSkip(state: LifecycleState, reason: CommitSkipReason, extra: Record<string, unknown> = {}): void {
  const last = (state.lastRunResult as Record<string, unknown> | undefined) ?? {};
  state.lastRunResult = {
    ...last,
    committed: false,
    commitSha: null,
    commitMessage: null,
    commitSkipReason: reason,
    ...extra,
  } as LifecycleState['lastRunResult'];
}

export async function gitCommitHandler(state: LifecycleState): Promise<void> {
  // Idempotency: skip if already settled
  if ((state.lastRunResult as { commitSkipReason?: unknown } | undefined)?.commitSkipReason !== undefined) return;
  if ((state.lastRunResult as { committed?: boolean } | undefined)?.committed === true) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const cwd = (state.cwd as string | undefined) ?? (ctx as { cwd?: string } | undefined)?.cwd;
  if (!cwd) return;
  const result = state.lastRunResult as Record<string, unknown> | undefined;
  if (!result) return;

  const startMs = Date.now();

  // Fast pre-gate: worker reported no file changes — skip before any
  // git work. Prevents `git add -A .` from staging stray working-tree
  // edits, and short-circuits when the worker errored without producing
  // artifacts (zero filesChanged).
  const filesChanged = (result.filesChanged as string[] | undefined) ?? [];
  if (filesChanged.length === 0) {
    setSkip(state, 'no_diff');
    return;
  }

  // Gate 1: no_repo
  if (!await isInsideWorkTree(cwd)) {
    setSkip(state, 'no_repo');
    return;
  }

  // Gate 2: worker_committed_out_of_band
  const currentSha = await currentHead(cwd);
  const preSha = (state as { preTaskHeadSha?: string }).preTaskHeadSha;
  if (preSha && currentSha && currentSha !== preSha) {
    setSkip(state, 'worker_committed_out_of_band', { detectedHeadSha: currentSha });
    return;
  }

  // Gate 3: validation_failed
  const validations = (result.validationsRun as { passed: boolean }[] | undefined) ?? [];
  if (validations.some((v) => !v.passed)) {
    setSkip(state, 'validation_failed');
    return;
  }

  // Gate 4: validation_stale (Rework ran but produced no fresh validations)
  if ((state as { reworkApplied?: boolean }).reworkApplied === true && validations.length === 0) {
    setSkip(state, 'validation_stale');
    return;
  }

  // Stage scoped to cwd
  const addR = await gitC(cwd, ['add', '-A', '.']);
  if (addR.code !== 0) {
    setSkip(state, 'hook_failed');
    return;
  }

  // Gate 6: no_diff (post-stage)
  const diffR = await gitC(cwd, ['diff', '--cached', '--quiet', '--', '.']);
  if (diffR.code === 0) {
    setSkip(state, 'no_diff');
    return;
  }

  // Resolve commit message: worker-supplied or model-generated.
  let commitMessage: string | undefined = (result.commitMessage as string | undefined);
  if (!commitMessage) {
    try {
      const session: Session = ctx!.getSession('standard');
      const diffOut = await gitC(cwd, ['diff', '--cached', '--', '.']);
      const truncated = diffOut.stdout.slice(0, 8000);
      const summary = (result.summary as string | undefined) ?? '';
      const turn = await session.send(
        `Generate a one-line Conventional Commits message for this diff.\n\nTask summary: ${summary}\n\nDiff:\n${truncated}`,
        { stageLabel: HUMAN_LABEL.committing },
      );
      commitMessage = turn.output.split('\n')[0].trim();
    } catch {
      /* fall through to template */
    }
    if (!commitMessage) {
      const summary = (result.summary as string | undefined) ?? 'update';
      commitMessage = `chore: ${summary.slice(0, 60)}`;
    }
  }

  // Commit
  const commitR = await gitC(cwd, ['commit', '-m', commitMessage]);
  if (commitR.code !== 0) {
    setSkip(state, 'hook_failed');
    return;
  }
  const newSha = await currentHead(cwd);

  state.lastRunResult = {
    ...result,
    committed: true,
    commitSha: newSha,
    commitMessage,
    commitSkipReason: null,
  } as LifecycleState['lastRunResult'];

  // Back-compat for downstream consumers (baseline-handlers + event-builder).
  state.commits = [{
    sha: newSha ?? '',
    subject: commitMessage,
    body: '',
    filesChanged: ((result.filesChanged as string[] | undefined) ?? []),
    authoredAt: new Date().toISOString(),
  }];

  mergeStageStats(state, 'committing', {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
    turnCount: 0,
    toolCallCount: 0,
    costUSD: null,
    durationMs: Date.now() - startMs,
    filesWrittenCount: ((result.filesChanged as string[] | undefined) ?? []).length,
  }, { tier: 'standard', model: null });
}
