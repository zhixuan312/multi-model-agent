import type { StagePlan, LifecycleState } from './stage-plan-types.js';
import type { StageGate, StageDefinition, RouteName } from './stage-io.js';
import type { ExecutionContext } from './lifecycle-context.js';
import { ContextBlockNotFoundError } from '../stores/context-block-tool.js';

export type StageHandler = (state: LifecycleState) => unknown;

const zeroTel = (label: string) => ({
  stageLabel: label,
  durationMs: 0,
  costUSD: 0,
  turnsUsed: 0,
  stopReason: 'normal' as const,
});

/**
 * v5 driver wrapper: writes a per-stage `StageGate` entry to `state.gates`
 * around each existing handler invocation. The driver itself remains
 * compatible with the legacy class API (StagePlan rows + handler registry);
 * the v5 behavior is additive — `state.gates[rowId]` is populated as each
 * row runs, so downstream consumers (compose, telemetry) can read it.
 */
export class LifecycleDriver {
  constructor(private plan: StagePlan, private handlers: Record<string, StageHandler>) {}

  async run(initialState: LifecycleState): Promise<LifecycleState> {
    const state = initialState;
    if (!state.gates) (state as { gates?: Record<string, StageGate<unknown>> }).gates = {};
    if (state.halted === undefined) (state as { halted?: boolean }).halted = false;

    for (const row of this.plan.rows) {
      const stageName = row.stageName ?? row.handlerKey ?? row.rowId;

      if (state.terminal && !row.runOnTerminal) {
        // Silent not_run — driver does not record a gate, matching spec §4.4.
        continue;
      }
      if (!row.runCondition(state)) {
        // runCondition returned false → this stage is skipped.
        // If the row provides an inline handler that returns a SKIP gate
        // (test convention for canonical comments), preserve its comment.
        // Otherwise (or if the handler returns anything else under skip
        // conditions), synthesize the default Layer-2 skip gate.
        let skipGate: StageGate<unknown> = {
          outcome: 'skip',
          payload: null,
          comment: `${stageName} skipped: runCondition returned false`,
          telemetry: zeroTel(stageName),
        };
        const inlineHandler = (row as { handler?: (s: LifecycleState) => unknown }).handler;
        if (typeof inlineHandler === 'function') {
          try {
            const ret = await inlineHandler(state);
            if (isStageGate(ret) && ret.outcome === 'skip') {
              skipGate = ret;
            }
          } catch { /* fall through to default skip */ }
        }
        state.gates![stageName] = skipGate;
        emitGateRecorded(state.executionContext, stageName, 'skip', skipGate.telemetry.costUSD, skipGate.telemetry.durationMs);
        continue;
      }

      const handler = this.handlers[row.handlerKey];
      if (!handler) throw new Error(`no handler registered for key '${row.handlerKey}'`);
      const ctx = state.executionContext as ExecutionContext | undefined;
      if (ctx?.wallClockGuard && !row.runOnTerminal) {
        try { ctx.wallClockGuard.checkOrThrow(); }
        catch (err) {
          state.terminal = true;
          (state as { errorCode?: string }).errorCode = (err as { errorCode?: string }).errorCode ?? 'guard_wall_clock';
          (state as { error?: string }).error = err instanceof Error ? err.message : String(err);
          const haltGate: StageGate<null> = {
            outcome: 'halt',
            payload: null,
            comment: `${stageName} halted: ${(err as Error).message}`,
            telemetry: { ...zeroTel(stageName), stopReason: 'timeout' as const },
          };
          state.gates![stageName] = haltGate;
          emitHaltEvent(ctx, stageName, haltGate.comment ?? `${stageName} halted`, 'timeout');
          state.halted = true;
          continue;
        }
      }

      const t0 = Date.now();
      try {
        const ret = await handler(state);
        // If the handler returned a StageGate-shaped object, use it. Otherwise
        // synthesize an advance gate from terminal state.
        const gate: StageGate<unknown> = isStageGate(ret)
          ? ret
          : {
              outcome: state.terminal ? 'halt' : 'advance',
              payload: null,
              telemetry: { ...zeroTel(stageName), durationMs: Date.now() - t0 },
            };
        state.gates![stageName] = gate;
        emitGateRecorded(state.executionContext, stageName, gate.outcome, gate.telemetry.costUSD, gate.telemetry.durationMs);
        if (gate.outcome === 'halt') {
          state.halted = true;
          emitHaltEvent(state.executionContext, stageName, gate.comment ?? '', gate.telemetry.stopReason);
        }
      } catch (err) {
        // Special-case: ContextBlockNotFoundError propagates so the dispatcher
        // can return 400. All other errors become halt gates.
        if (err instanceof ContextBlockNotFoundError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const tCatch = Date.now() - t0;
        state.gates![stageName] = {
          outcome: 'halt',
          payload: null,
          comment: `${stageName} crashed: ${msg}`,
          telemetry: { ...zeroTel(stageName), stopReason: 'transport_error', durationMs: tCatch },
        };
        emitGateRecorded(state.executionContext, stageName, 'halt', null, tCatch);
        state.halted = true;
        state.terminal = true;
        emitHaltEvent(state.executionContext, stageName, `${stageName} crashed: ${msg}`, 'transport_error');
      }
    }
    return state;
  }
}

function isStageGate(x: unknown): x is StageGate<unknown> {
  return (
    typeof x === 'object' && x !== null
    && 'outcome' in x
    && 'payload' in x
    && 'telemetry' in x
  );
}

/**
 * v5 driver: walks STAGE_PLAN (StageDefinition[]) applying Layer-1
 * (applicableRoutes) then Layer-2 (shouldRun) per spec §4.4. Returns the
 * final state with state.gates populated. Handler exceptions become halt
 * gates (except ContextBlockNotFoundError which propagates).
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
    // Halt check
    if (state.halted && !stage.runOnHalt) {
      continue;                                                       // silent not_run
    }

    // Layer 1: route filter
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

    // Layer 2: state filter
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

    // Run handler with exception → halt synthesis (except ContextBlockNotFoundError)
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
      emitHaltEvent(state.executionContext, stage.name, haltGate.comment ?? '', 'transport_error');
    }
  }

  return state;
}

/** Emit a stage_halt bus event on every halt (spec §15.3). */
function emitHaltEvent(
  ctx: ExecutionContext | undefined,
  stageName: string,
  comment: string,
  stopReason: string,
): void {
  ctx?.bus?.emit({ event: 'stage_halt', ts: new Date().toISOString(), stageName, comment, stopReason } as Record<string, unknown>);
}

/** Emit a stage_gate_recorded debug log event on every gate transition (spec §15.3). */
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
