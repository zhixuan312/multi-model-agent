// v5 lifecycle driver — walks STAGE_PLAN (StageDefinition[]) applying
// Layer-1 (applicableRoutes) then Layer-2 (shouldRun) per spec §4.4.

import type { LifecycleState } from './stage-plan-types.js';
import type { StageGate, StageDefinition, RouteName } from './stage-io.js';
import type { ExecutionContext } from './lifecycle-context.js';
import { ContextBlockNotFoundError } from '../stores/context-block-tool.js';
import { GuardError } from '../bounded-execution/wall-clock-guard.js';

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
      continue;
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
      const gate = await stage.handler(state);
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
  ctx?.bus?.emit({ event: 'stage_halt', ts: new Date().toISOString(), stageName, comment, stopReason } as Record<string, unknown>);
}

function emitGateRecorded(
  ctx: ExecutionContext | undefined,
  stageName: string,
  outcome: 'advance' | 'skip' | 'halt',
  costUSD: number | null,
  durationMs: number,
): void {
  ctx?.bus?.emit({
    event: 'stage_gate_recorded',
    ts: new Date().toISOString(),
    stage: stageName,
    outcome,
    costUSD,
    durationMs,
  } as Record<string, unknown>);
}
