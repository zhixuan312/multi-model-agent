import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { TaskSpec, RunResult } from '../../types.js';
import { runCommitStage, type CommitStageResult } from './commit-stage.js';
import type { CommitFields } from '../../reporting/structured-report.js';

/**
 * StageHandler for row 5.2 (git_commit).
 *
 * Reads from state:
 *   - state.task: TaskSpec (for commit metadata)
 *   - state.executionContext: cwd
 *   - state.lastRunResult.filesWritten: which paths to commit
 *   - state.commits: idempotency guard — skip if already populated
 *
 * Writes to state:
 *   - state.commits: array of CommitStageResult
 *   - state.commitError: string when commit failed
 *
 * Today the legacy executor (executeReviewedLifecycle) owns commit. This
 * handler is wired into the stage registry but defensively no-ops on
 * missing state slots; full activation lands with Step 5 when run_initial_impl
 * decomposition makes per-task data flow available.
 */
export async function gitCommitHandler(state: LifecycleState): Promise<void> {
  // Idempotency: legacy executor populates state.commits during the cutover
  // transition. Skip if already done — prevents double-commit when both the
  // executor and the handler run.
  if (Array.isArray(state.commits) && state.commits.length > 0) return;
  if (typeof state.commitError === 'string') return;

  const task = state.task as TaskSpec | undefined;
  const ctx = state.executionContext as ExecutionContext | undefined;
  const last = state.lastRunResult as RunResult | undefined;

  // Defensive no-op when data flow isn't ready (Steps 1 + 5 populate these).
  if (!task || !ctx || !last) return;

  const filesWritten = Array.isArray(last.filesWritten) ? last.filesWritten : [];
  if (filesWritten.length === 0) return;

  const commitFields: CommitFields = (last.parsedFindings as { commit?: CommitFields } | null)?.commit ?? {
    type: 'feat',
    subject: 'automated commit',
    body: '',
  };

  try {
    const result: CommitStageResult = await runCommitStage({
      cwd: ctx.cwd,
      filesWritten,
      commit: commitFields,
    });
    state.commits = [result];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.commitError = message;
  }
}
