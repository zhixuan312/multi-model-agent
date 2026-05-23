import { describe, it, expect } from 'vitest';
import { runStagePlan } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { StageDefinition, StageGate } from '../../packages/core/src/lifecycle/stage-io.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

describe('A10.4 wall-clock guard end-to-end through lifecycle driver', () => {
  it('guard firing mid-plan halts execution and skips later non-terminal rows', async () => {
    let shouldFire = false;
    const guard = {
      checkOrThrow(): void {
        if (shouldFire) {
          const err = new Error('wall-clock budget exceeded (50ms)') as Error & { errorCode?: string };
          err.errorCode = 'guard_wall_clock';
          throw err;
        }
      },
    };

    const calls: string[] = [];

    const customPlan: StageDefinition<unknown>[] = [
      {
        name: 'stage_a',
        applicableRoutes: 'all',
        runOnHalt: false,
        shouldRun: () => ({ run: true }),
        handler: async () => {
          calls.push('a');
          return {
            outcome: 'advance',
            payload: null,
            telemetry: { stageLabel: 'stage_a', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
      {
        name: 'stage_b',
        applicableRoutes: 'all',
        runOnHalt: false,
        shouldRun: () => ({ run: true }),
        handler: async () => {
          calls.push('b');
          return {
            outcome: 'advance',
            payload: null,
            telemetry: { stageLabel: 'stage_b', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
      {
        name: 'stage_c',
        applicableRoutes: 'all',
        runOnHalt: false,
        shouldRun: () => ({ run: true }),
        handler: async () => {
          calls.push('c');
          return {
            outcome: 'advance',
            payload: null,
            telemetry: { stageLabel: 'stage_c', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
      {
        name: 'finalize',
        applicableRoutes: 'all',
        runOnHalt: true,
        shouldRun: () => ({ run: true }),
        handler: async () => {
          calls.push('finalize');
          return {
            outcome: 'advance',
            payload: null,
            telemetry: { stageLabel: 'finalize', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
    ];

    // First run — guard doesn't fire
    shouldFire = false;
    const state = {
      terminal: false,
      reviewPolicy: 'full',
      shutdownInProgress: false,
      route: 'delegate',
      executionContext: { wallClockGuard: guard, bus: { emit: () => {} } },
    } as unknown as LifecycleState;
    await runStagePlan(customPlan, state);
    expect(calls).toEqual(['a', 'b', 'c', 'finalize']);

    // Second run — guard fires and halts the plan
    calls.length = 0;
    shouldFire = true;
    const state2 = {
      terminal: false,
      reviewPolicy: 'full',
      shutdownInProgress: false,
      route: 'delegate',
      executionContext: { wallClockGuard: guard, bus: { emit: () => {} } },
    } as unknown as LifecycleState;
    await runStagePlan(customPlan, state2);

    // Guard fires on stage_a, which creates a halt gate; stage_b and stage_c skipped (halted=true),
    // finalize runs (runOnHalt: true)
    expect(calls).toEqual(['finalize']);
    expect(state2.gates?.['stage_a']?.outcome).toBe('halt');
  });
});
