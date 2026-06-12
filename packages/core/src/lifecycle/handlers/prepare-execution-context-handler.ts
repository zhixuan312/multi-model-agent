import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate } from '../stage-io.js';
import type { TaskSpec } from '../../types.js';

/**
 * Stage handler: row 2.5 — prepare_execution_context.
 *
 * Seeding: populates state.task, state.reviewPolicy. This handler is the
 * canonical "state was set up correctly" acknowledgment for downstream
 * handlers that read from these slots.
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
        stopReason: 'transport_error',
      },
    };
  }
}