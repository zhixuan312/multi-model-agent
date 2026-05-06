import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
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
 *     Multi-task fan-out lives in the executeDelegate per-task loop today;
 *     once Step 5's full cutover lands, runTasks dispatches one StagePlan per
 *     TaskSpec and state.task is the per-dispatch task. This minimal handler
 *     surfaces task[0] so handlers downstream of it (run_verify_command,
 *     git_commit, etc.) can defensive-no-op or activate uniformly.
 *
 * Until full cutover, the legacy executor closure populated by HTTP handlers
 * still owns the live path. This handler exists so the per-row handler
 * registry has no stage-key gaps and so the cutover surface is well-defined:
 * once HTTP handlers stop wiring DispatchInput.executor and instead supply
 * DispatchInput.context = { task, executionContext }, the new path activates.
 */
export function prepareExecutionContextHandler(state: LifecycleState): void {
  // Idempotency: when DispatchInput.context already supplied these slots,
  // honor them and don't overwrite. This is the lever for the eventual
  // cutover — callers populate context, this handler accepts it as canonical.
  if (state.executionContext && state.task) return;

  // Fallback: if rawRequest carries a TaskSpec[] and state.task is empty,
  // surface the first task so per-task handlers have something to read. This
  // is best-effort — full multi-task fan-out happens upstream of dispatch
  // (in runTasks) once the cutover lands.
  if (!state.task) {
    const req = state.request as { tasks?: TaskSpec[] } | undefined;
    const first = req?.tasks?.[0];
    if (first) state.task = first;
  }

  // state.executionContext is intentionally NOT defaulted here. It carries
  // batch-scoped state (providers, timing, bus, heartbeat) that this handler
  // can't synthesize from the rawRequest alone. Callers that want the new
  // path running must supply executionContext via DispatchInput.context.
  void (state as { executionContext?: ExecutionContext }).executionContext;
}
