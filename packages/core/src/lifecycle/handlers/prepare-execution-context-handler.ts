import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate } from '../stage-io.js';
import type { TaskSpec } from '../../types.js';
import { DiffTracker } from '../diff-tracker.js';

/**
 * Stage handler: row 2.5 — prepare_execution_context.
 *
 * Seeding: populates state.task, state.reviewPolicy, state.diffTracker.
 * This handler is the canonical "state was set up correctly" acknowledgment
 * for downstream handlers that read from these slots.
 *
 * §5.1 payload: null. Gate exists only for the per-stage telemetry slot.
 */
export async function prepareExecutionContextHandler(
  state: LifecycleState,
): Promise<StageGate<null>> {
  const t0 = Date.now();

  try {
    // Fallback: if rawRequest carries a TaskSpec[] and state.task is empty,
    // surface the first task so per-task handlers have something to read.
    if (!state.task) {
      const req = state.request as { tasks?: TaskSpec[] } | undefined;
      const first = req?.tasks?.[0];
      if (first) state.task = first;
    }

    // #45 Step 7e: per-task reviewPolicy lives on TaskSpec, not on rawRequest's
    // top-level. Override state.reviewPolicy from state.task when present so
    // the per-row runConditions (gating spec/quality/diff chains) see the
    // right value.
    const task = state.task as TaskSpec | undefined;
    if (task?.reviewPolicy) {
      state.reviewPolicy = task.reviewPolicy;
    }

    // Tool sweep #6: snapshot the worker's declared filePaths BEFORE the
    // implementer runs so reviewer stages can produce a cumulative diff
    // against the pre-task baseline. Skip read-only routes (audit / review
    // / verify / debug / investigate / explore) — they don't write files
    // by sandbox policy, so a tracker would just be empty noise.
    if (!state.diffTracker && task && state.toolCategory !== 'read_only') {
      const cwd = task.cwd;
      const filePaths = Array.isArray(task.filePaths) ? task.filePaths : [];
      if (cwd && filePaths.length > 0) {
        const tracker = new DiffTracker(cwd);
        try {
          await tracker.snapshot(filePaths);
          state.diffTracker = tracker;
        } catch {
          // Snapshot failures (permission, unreadable) shouldn't block the
          // task. Reviewer just sees an empty diff and falls back to the
          // worker-output-only path — degraded but not broken.
        }
      }
    }

    return {
      outcome: 'advance',
      payload: null,
      telemetry: {
        stageLabel: 'prepare',
        durationMs: Date.now() - t0,
        costUSD: 0,
        turnsUsed: 0,
        stopReason: 'normal',
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const comment =
      /brief schema|invalid brief/i.test(msg) ? `brief_invalid: ${msg}` :
      /workspace|traversal|sandbox/i.test(msg) ? `workspace_violation: ${msg}` :
      /context_block|missing/i.test(msg) ? `context_block_missing: ${msg}` :
      `prepare_failed: ${msg}`;

    return {
      outcome: 'halt',
      comment,
      payload: null,
      telemetry: {
        stageLabel: 'prepare',
        durationMs: Date.now() - t0,
        costUSD: 0,
        turnsUsed: 0,
        stopReason: 'halted',
      },
    };
  }
}