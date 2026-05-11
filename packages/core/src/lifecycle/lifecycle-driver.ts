import type { StagePlan, LifecycleState } from './stage-plan-types.js';
import type { ExecutionContext } from './lifecycle-context.js';

export type StageHandler = (state: LifecycleState) => Promise<void> | void;

export class LifecycleDriver {
  constructor(private plan: StagePlan, private handlers: Record<string, StageHandler>) {}

  async run(initialState: LifecycleState): Promise<LifecycleState> {
    const state = initialState;
    for (const row of this.plan.rows) {
      if (state.terminal && !row.runOnTerminal) continue;
      if (!row.runCondition(state)) continue;
      const handler = this.handlers[row.handlerKey];
      if (!handler) throw new Error(`no handler registered for key '${row.handlerKey}'`);
      const ctx = state.executionContext as ExecutionContext | undefined;
      if (ctx && !row.runOnTerminal) {
        try { ctx.wallClockGuard.checkOrThrow(); }
        catch (err) {
          state.terminal = true;
          (state as { errorCode?: string }).errorCode = (err as { errorCode?: string }).errorCode ?? 'guard_wall_clock';
          (state as { error?: string }).error = err instanceof Error ? err.message : String(err);
          continue;
        }
      }
      await handler(state);
    }
    return state;
  }
}
