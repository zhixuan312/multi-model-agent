// v5 lifecycle driver — walks STAGE_PLAN (StageDefinition[]) applying
// Layer-1 (applicableRoutes) then Layer-2 (shouldRun) per spec §4.4.

import type { LifecycleState } from './stage-plan-types.js';
import type { StageGate, StageDefinition, RouteName } from './stage-io.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { StageLabel } from './stage-labels.js';
import { ContextBlockNotFoundError } from '../stores/context-block-tool.js';
import { GuardError } from '../bounded-execution/wall-clock-guard.js';

/** Maps STAGE_PLAN row name → visible heartbeat stage label. Only stages
 *  that appear here count toward the user-visible (N/M) progress counter
 *  and trigger heartbeat.transition() from the driver. The other four
 *  rows (prepare, register-block, compose, terminal) are bookkeeping. */
const VISIBLE_STAGE_LABEL: Record<string, StageLabel> = {
  implement: 'implementing',
  review: 'review',
  rework: 'rework',
  commit: 'committing',
  annotate: 'annotating',
};

function isVisibleStage(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VISIBLE_STAGE_LABEL, name);
}

/** Returns a promise that rejects when the signal aborts. Lets stage-handler
 *  awaits unwind on watchdog abort even when the handler itself does not
 *  observe the signal directly. Stays pending forever if no signal. */
function abortAsRejection(signal: AbortSignal | undefined, message: string): Promise<never> {
  if (!signal) return new Promise(() => { /* never resolves */ });
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new Error(message)); return; }
    signal.addEventListener('abort', () => reject(new Error(message)), { once: true });
  });
}

/**
 * Walk `plan` in order. For each stage:
 *   1. If halted and not `runOnHalt`, silently skip (no gate recorded).
 *   2. Layer-1 — check `applicableRoutes`; record a skip gate when route
 *      doesn't apply.
 *   3. Layer-2 — call `shouldRun(state)`; record a skip gate when it
 *      returns `{run: false}`.
 *   4. Run the handler; record the returned gate. Halts set `state.halted`.
 *
 * Handler exceptions become halt gates (except `ContextBlockNotFoundError`,
 * which propagates so the dispatcher can return a structured 400).
 */
export async function runStagePlan(
  plan: StageDefinition<unknown>[],
  initial: LifecycleState,
): Promise<LifecycleState> {
  const state = initial;
  if (!state.gates) (state as { gates?: Record<string, StageGate<unknown>> }).gates = {};
  if (state.halted === undefined) (state as { halted?: boolean }).halted = false;

  const route = (state.route as RouteName | undefined) ?? 'delegate';

  // Initial upper bound: count every STAGE_PLAN row whose name is in
  // VISIBLE_STAGE_LABEL AND whose applicableRoutes match the current
  // route. shouldRun() decisions arrive later (state-dependent); we
  // decrement `visibleTotal` on every visible skip we encounter.
  let visibleRan = 0;
  let visibleTotal = plan.filter((s) =>
    isVisibleStage(s.name) &&
    (s.applicableRoutes === 'all' ||
     (s.applicableRoutes as readonly string[]).includes(route)),
  ).length;

  for (const stage of plan) {
    if (state.halted && !stage.runOnHalt) continue;

    const applies = stage.applicableRoutes === 'all'
      ? true
      : (stage.applicableRoutes as readonly string[]).includes(route);
    if (!applies) {
      const skipGate: StageGate<null> = {
        outcome: 'skip',
        comment: `${stage.name} does not apply to route=${route}`,
        payload: null,
        telemetry: { stageLabel: stage.name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
      };
      state.gates![stage.name] = skipGate;
      emitGateRecorded(state.executionContext, stage.name, 'skip', 0, 0);
      if (isVisibleStage(stage.name)) visibleTotal -= 1; // ADDED
      continue;
    }

    const decision = stage.shouldRun(state);
    if (!decision.run) {
      const skipGate: StageGate<null> = {
        outcome: 'skip',
        comment: decision.comment,
        payload: null,
        telemetry: { stageLabel: stage.name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
      };
      state.gates![stage.name] = skipGate;
      emitGateRecorded(state.executionContext, stage.name, 'skip', 0, 0);
      if (isVisibleStage(stage.name)) visibleTotal -= 1; // ADDED
      continue;
    }

    if (isVisibleStage(stage.name)) {
      visibleRan += 1;
      const wireStage = VISIBLE_STAGE_LABEL[stage.name];
      const tracker = (state.executionContext as { heartbeat?: { transition: (f: Record<string, unknown>) => void } } | undefined)?.heartbeat;
      if (tracker) {
        try {
          const transitionFields: Record<string, unknown> = {
            stage: wireStage,
            stageIndex: visibleRan,
            stageCount: Math.max(visibleRan, visibleTotal),
          };
          // review/rework require reviewRound + attemptCap (enforced by
          // ActivityTracker.transition). Default to 1/1 — handlers do not
          // currently track multi-round review state on state.reviewRound.
          if (wireStage === 'review' || wireStage === 'rework') {
            const stateAny = state as { reviewRound?: number; attemptCap?: number };
            transitionFields.reviewRound = stateAny.reviewRound ?? 1;
            transitionFields.attemptCap = stateAny.attemptCap ?? 1;
          }
          tracker.transition(transitionFields);
        } catch (e) {
          // Heartbeat errors must not abort the lifecycle. Mirror the
          // safeTracker pattern from perform-implementation.ts.
          const logger = (state.executionContext as { logger?: { error: (kind: string, err: unknown) => void } } | undefined)?.logger;
          logger?.error?.('heartbeat_transition_failed', e);
        }
      }
    }

    // Wall-clock guard before each non-runOnHalt stage.
    const ctx = state.executionContext as ExecutionContext | undefined;
    if (ctx?.wallClockGuard && !stage.runOnHalt) {
      try {
        ctx.wallClockGuard.checkOrThrow();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const timeoutKind = err instanceof GuardError && err.errorCode === 'guard_wall_clock' ? 'wall_clock' : 'unknown';
        const haltGate: StageGate<null> = {
          outcome: 'halt',
          comment: `${stage.name} halted: ${msg}`,
          payload: null,
          telemetry: { stageLabel: stage.name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'timeout', timeoutKind },
        };
        state.gates![stage.name] = haltGate;
        state.halted = true;
        emitGateRecorded(ctx, stage.name, 'halt', 0, 0);
        emitHaltEvent(ctx, stage.name, haltGate.comment ?? '', 'timeout');
        continue;
      }
    }

    const t0 = Date.now();
    try {
      const stallSignal = (state.executionContext as ExecutionContext | undefined)?.stall?.controller?.signal;
      const gate = await Promise.race([
        stage.handler(state),
        abortAsRejection(stallSignal, `stage ${stage.name} aborted by stall watchdog`),
      ]);
      state.gates![stage.name] = gate;
      emitGateRecorded(state.executionContext, stage.name, gate.outcome, gate.telemetry.costUSD, gate.telemetry.durationMs);
      if (gate.outcome === 'halt') {
        state.halted = true;
        emitHaltEvent(state.executionContext, stage.name, gate.comment ?? '', gate.telemetry.stopReason);
      }
    } catch (err) {
      if (err instanceof ContextBlockNotFoundError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const tCatch = Date.now() - t0;
      const haltGate: StageGate<null> = {
        outcome: 'halt',
        comment: `${stage.name} crashed: ${msg}`,
        payload: null,
        telemetry: { stageLabel: stage.name, durationMs: tCatch, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' },
      };
      state.gates![stage.name] = haltGate;
      emitGateRecorded(state.executionContext, stage.name, 'halt', 0, tCatch);
      state.halted = true;
      state.terminal = true;
      emitHaltEvent(state.executionContext, stage.name, haltGate.comment ?? '', 'transport_error');
    }
  }

  return state;
}

function emitHaltEvent(
  ctx: ExecutionContext | undefined,
  stageName: string,
  comment: string,
  stopReason: string,
): void {
  // Stage halt events are no longer emitted via the bus; they are recorded
  // through the envelope API via envelope.seal() or other stage-tracking methods.
}

function emitGateRecorded(
  ctx: ExecutionContext | undefined,
  stageName: string,
  outcome: 'advance' | 'skip' | 'halt',
  costUSD: number | null,
  durationMs: number,
): void {
  // Gate recording events are no longer emitted via the bus; they are recorded
  // through the envelope API via envelope.completeStage() or other mutations.
}
