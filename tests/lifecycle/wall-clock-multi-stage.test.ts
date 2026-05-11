import { describe, it, expect } from 'vitest';
import { LifecycleDriver } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { StagePlan, LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeRow(rowId: string, handlerKey: string, opts: { runOnTerminal?: boolean; schemaStage?: string } = {}) {
  return {
    rowId,
    stageName: handlerKey,
    runCondition: () => true,
    isRework: false,
    handlerKey,
    ...(opts.runOnTerminal !== undefined && { runOnTerminal: opts.runOnTerminal }),
    ...(opts.schemaStage !== undefined && { schemaStage: opts.schemaStage }),
  };
}

describe('A10.4 wall-clock guard end-to-end through lifecycle driver', () => {
  it('guard firing mid-plan marks state terminal with errorCode=guard_wall_clock and skips later non-terminal rows', async () => {
    const fired = { value: false };
    const guard = {
      checkOrThrow(): void {
        if (fired.value) {
          const err = new Error('wall-clock budget exceeded (50ms)') as Error & { errorCode?: string };
          err.errorCode = 'guard_wall_clock';
          throw err;
        }
      },
    };

    const calls: string[] = [];
    const handlers = {
      stage_a: () => { calls.push('a'); },
      stage_b: () => { calls.push('b'); },
      stage_c: () => { calls.push('c'); },
      finalize: () => { calls.push('finalize'); },
    };

    const plan: StagePlan = {
      toolCategory: 'artifact_producing',
      rows: [
        makeRow('1', 'stage_a'),
        makeRow('2', 'stage_b'),
        makeRow('3', 'stage_c'),
        makeRow('4', 'finalize', { runOnTerminal: true }),
      ],
    };

    const driver = new LifecycleDriver(plan, handlers);
    const state = {
      terminal: false,
      reviewPolicy: 'full',
      attemptIndex: 0,
      attemptBudget: 1,
      shutdownInProgress: false,
      executionContext: { wallClockGuard: guard },
    } as unknown as LifecycleState;

    fired.value = false;
    await driver.run(state);
    expect(calls).toEqual(['a', 'b', 'c', 'finalize']);

    calls.length = 0;
    fired.value = true;
    const state2 = {
      terminal: false,
      reviewPolicy: 'full',
      attemptIndex: 0,
      attemptBudget: 1,
      shutdownInProgress: false,
      executionContext: { wallClockGuard: guard },
    } as unknown as LifecycleState;
    await driver.run(state2);

    expect(state2.terminal).toBe(true);
    expect((state2 as { errorCode?: string }).errorCode).toBe('guard_wall_clock');
    expect(calls).toEqual(['finalize']);
  });
});
