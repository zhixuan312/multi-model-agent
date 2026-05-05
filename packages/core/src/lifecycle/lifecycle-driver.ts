import type { StagePlan, LifecycleState } from './stage-plan-types.js';

export type StageHandler = (state: LifecycleState) => Promise<void> | void;

export class LifecycleDriver {
  constructor(private plan: StagePlan, private handlers: Record<string, StageHandler>) {}

  async run(initialState: LifecycleState): Promise<LifecycleState> {
    const state = initialState;
    for (const row of this.plan.rows) {
      // Rows marked runOnTerminal still evaluate their runCondition even
      // after a prior row set state.terminal=true. This is how settle_*_chain,
      // compose_response, register_terminal_block, emit_task_terminal,
      // persist_to_batch_registry, and flush_telemetry continue to fire on
      // hard-fail paths so chain-pass slots, response envelopes, and
      // telemetry stay authoritative.
      if (state.terminal && !row.runOnTerminal) break;
      if (!row.runCondition(state)) continue;
      const handler = this.handlers[row.handlerKey];
      if (!handler) throw new Error(`no handler registered for key '${row.handlerKey}'`);
      await handler(state);
    }
    return state;
  }
}
