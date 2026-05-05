import type { LifecycleState } from '../stage-plan-types.js';
import type { EventEmitter } from '../../events/event-emitter.js';
import type { TaskSpec } from '../../types.js';
import { runVerifyStage, type VerifyStageResult } from './verify-stage.js';
import type { ExecutionContext } from '../lifecycle-context.js';

/**
 * StageHandler for row 5.1 (run_verify_command).
 *
 * Reads from state:
 *   - state.task: TaskSpec with verifyCommand + cwd + timeoutMs
 *   - state.executionContext: timing budgets, bus, stageStats
 *   - state.verifyResult: idempotency guard — if already populated by an
 *     upstream stage (e.g., the legacy executor during the Step 5 transition),
 *     this handler skips so verify doesn't run twice.
 *
 * Writes to state:
 *   - state.verifyResult: VerifyStageResult
 *   - state.stageStats: aggregated via endVerifyStage()
 *
 * Emits via ctx.bus:
 *   - 'verify_step' per step
 *   - 'verify_skipped' when no command or skipped
 *
 * This handler is registered in stage-handlers.ts but stays inert until
 * state.task and state.executionContext are populated (Steps 1 + 5). The
 * runCondition on row 5.1 (toolCategory==='artifact_producing' &&
 * route!=='verify' && reviewPolicy!=='none' && !terminal) gates entry; once
 * inside, the handler defensively no-ops on missing state slots so a partial
 * decomposition state doesn't crash the lifecycle.
 */
export async function runVerifyCommandHandler(state: LifecycleState): Promise<void> {
  // Idempotency: if a prior stage (or the legacy executor) already populated
  // verifyResult, treat this row as a structural acknowledgment and don't
  // re-run the verify command. Step 5 wiring removes the need for this guard.
  if (state.verifyResult) return;

  const task = state.task as TaskSpec | undefined;
  const ctx = state.executionContext as ExecutionContext | undefined;

  // Defensive no-op when the data flow isn't set up yet. Step 1 +
  // Step 5 populate state.task and state.executionContext; until then this
  // handler can't do real work, and the legacy executor still owns verify.
  if (!task || !ctx) return;

  const verifyCommand = task.verifyCommand;
  const cwd = ctx.cwd;
  const taskTimeoutMs = ctx.timing.timeoutMs;
  const taskStartMs = ctx.timing.startMs;

  const verification = await runVerifyStage({
    cwd,
    verifyCommand,
    taskTimeoutMs,
    taskStartMs,
  });

  state.verifyResult = verification;

  emitVerifyEvents(ctx.bus, verification);

  // Stage stats integration deferred: endVerifyStage takes cost meter +
  // agent info + idle stats that don't yet flow through ExecutionContext.
  // Step 6 (terminal handlers) will fold verify outcome into stageStats once
  // cost-rollup and idle tracking are part of the context.
}

function emitVerifyEvents(bus: EventEmitter | undefined, verification: VerifyStageResult): void {
  if (!bus) return;
  for (const step of verification.steps) {
    bus.emit({
      event: 'verify_step',
      ts: new Date().toISOString(),
      command: step.command,
      status: step.status,
      ...(step.exitCode !== null && { exitCode: step.exitCode }),
      ...(step.signal !== null && { signal: step.signal }),
      durationMs: step.durationMs,
      ...(step.errorMessage !== null && { errorMessage: step.errorMessage }),
    } as Record<string, unknown>);
  }
  if (verification.status === 'skipped') {
    bus.emit({
      event: 'verify_skipped',
      ts: new Date().toISOString(),
      reason: verification.skipReason ?? 'no_command',
      stage: 'verifying',
    } as Record<string, unknown>);
  }
}
