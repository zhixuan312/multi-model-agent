import type { StagePlan, LifecycleState } from './stage-plan-types.js';

export type StageHandler = (state: LifecycleState) => Promise<void> | void;

export class LifecycleDriver {
  constructor(private plan: StagePlan, private handlers: Record<string, StageHandler>) {}

  async run(initialState: LifecycleState): Promise<LifecycleState> {
    const state = initialState;
    for (const row of this.plan.rows) {
      if (state.terminal) break;
      if (!row.runCondition(state)) continue;
      const handler = this.handlers[row.handlerKey];
      if (!handler) throw new Error(`no handler registered for key '${row.handlerKey}'`);
      await handler(state);
    }
    return state;
  }
}
