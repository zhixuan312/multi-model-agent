import type { LifecycleState } from '../stage-plan-types.js';
import type { TaskSpec } from '../../types.js';

/**
 * StageHandler for row 2.5 (prepare_execution_context).
 *
 * Reads from state:
 *   - state.task / state.executionContext: idempotency guards. If callers
 *     pre-populate them via DispatchInput.context (or a future intake step),
 *     this handler is a structural acknowledgment.
 *   - state.request: the rawRequest passed to dispatch. Used as a fallback
 *     to surface the tasks list when callers haven't supplied state.task.
 *
 * Writes to state (only when slots are empty AND request is shaped for it):
 *   - state.task: the first TaskSpec from a delegate-style request payload.
 *     runTasks (in task-runner.ts) dispatches one StagePlan per TaskSpec,
 *     so state.task is the per-dispatch task. This handler surfaces task[0]
 *     as a fallback for downstream handlers that need a TaskSpec.
 */
export function prepareExecutionContextHandler(state: LifecycleState): void {
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
  // right value. This must run unconditionally — callers via
  // runTaskViaDispatcher pre-populate state.task + state.executionContext but
  // the dispatcher's initialState defaults state.reviewPolicy to 'full' since
  // the per-task reviewPolicy isn't visible at top-level rawRequest.
  const task = state.task as TaskSpec | undefined;
  if (task && task.reviewPolicy) {
    state.reviewPolicy = task.reviewPolicy;
  }

}
