import type { StagePlan, LifecycleState } from './stage-plan-types.js';
import type { StageGate } from './stage-io.js';
import type { ExecutionContext } from './lifecycle-context.js';

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
        // Layer-2 skip — synthesize a skip gate so downstream knows why.
        state.gates![stageName] = {
          outcome: 'skip',
          payload: null,
          comment: `${stageName} skipped: runCondition returned false`,
          telemetry: zeroTel(stageName),
        };
        continue;
      }

      const handler = this.handlers[row.handlerKey];
      if (!handler) throw new Error(`no handler registered for key '${row.handlerKey}'`);
      const ctx = state.executionContext as ExecutionContext | undefined;
      if (ctx && !row.runOnTerminal) {
        try { ctx.wallClockGuard.checkOrThrow(); }
        catch (err) {
          state.terminal = true;
          (state as { errorCode?: string }).errorCode = (err as { errorCode?: string }).errorCode ?? 'guard_wall_clock';
          (state as { error?: string }).error = err instanceof Error ? err.message : String(err);
          state.gates![stageName] = {
            outcome: 'halt',
            payload: null,
            comment: `${stageName} halted: ${(err as Error).message}`,
            telemetry: { ...zeroTel(stageName), stopReason: 'timeout' as const },
          };
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
        if (gate.outcome === 'halt') state.halted = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        state.gates![stageName] = {
          outcome: 'halt',
          payload: null,
          comment: `${stageName} crashed: ${msg}`,
          telemetry: { ...zeroTel(stageName), stopReason: 'transport_error', durationMs: Date.now() - t0 },
        };
        state.halted = true;
        state.terminal = true;
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
