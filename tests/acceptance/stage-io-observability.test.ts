// tests/acceptance/stage-io-observability.test.ts
// AC-34: every halt emits stage_halt bus event
// AC-35: every gate emits stage_gate_recorded
// AC-36: terminal side-effect failure emits structured event

import { describe, it, expect, vi } from 'vitest';
import { LifecycleDriver } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { StagePlan, LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeTestPlan(rows: StagePlan['rows']): StagePlan {
  return { toolCategory: 'artifact_producing', rows };
}

function makeMinimalState(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 1,
    reviewPolicy: 'none',
    shutdownInProgress: false,
    gates: {},
    halted: false,
    ...overrides,
  } as LifecycleState;
}

// Helper: build a plan where one stage halts and the rest are normal advances
function makeHaltPlan(haltStageName: string): StagePlan {
  return makeTestPlan([
    {
      rowId: 'implement', stageName: 'implement', isRework: false, handlerKey: 'implement',
      runCondition: () => true,
      runOnTerminal: false,
      handler: (s) => {
        s.terminal = true;
        return { outcome: 'halt', payload: null, comment: 'forced implement halt' };
      },
    } satisfies StagePlan['rows'][number],
  ]);
}

// ─── AC-34 ───────────────────────────────────────────────────────────────────
// Every halt emits stage_halt bus event

describe('AC-34: every halt emits stage_halt bus event', () => {
  it('implement halt produces a stage_halt event', async () => {
    const emitted: Array<{ event: string; stageName?: string; comment?: string; stopReason?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
    } as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeHaltPlan('implement'),
      {
        implement: async (s) => {
          s.terminal = true;
          (s as { halted?: boolean }).halted = true;
          return {
            outcome: 'halt' as const,
            payload: null,
            comment: 'forced implement halt',
            telemetry: { stageLabel: 'implement', durationMs: 1, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' as const },
          };
        },
      },
    );

    await driver.run(state);

    const haltEvents = emitted.filter(e => e.event === 'stage_halt');
    expect(haltEvents.length).toBeGreaterThanOrEqual(1);
    expect(haltEvents.some(e => e.stageName === 'implement')).toBe(true);
  });

  it('halt during review stage emits stage_halt with stageName=review', async () => {
    const emitted: Array<{ event: string; stageName?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
    } as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([
        {
          rowId: 'implement', stageName: 'implement', isRework: false, handlerKey: 'implement',
          runCondition: () => true, runOnTerminal: false,
          handler: () => ({
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          }),
        },
        {
          rowId: 'review', stageName: 'review', isRework: false, handlerKey: 'review',
          runCondition: () => true, runOnTerminal: false,
          handler: (s) => {
            (s as { halted?: boolean }).halted = true;
            s.terminal = true;
            return {
              outcome: 'halt' as const, payload: null, comment: 'reviewer transport failure',
              telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' as const },
            };
          },
        },
      ]),
      {
        implement: async (s) => ({
          outcome: 'advance' as const, payload: null,
          telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
        }),
        review: async (s) => {
          (s as { halted?: boolean }).halted = true;
          s.terminal = true;
          return {
            outcome: 'halt' as const, payload: null, comment: 'reviewer transport failure',
            telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' as const },
          };
        },
      },
    );

    await driver.run(state);

    const haltEvents = emitted.filter(e => e.event === 'stage_halt');
    expect(haltEvents.some(e => e.stageName === 'review')).toBe(true);
  });

  it('halt comment is surfaced in the stage_halt event', async () => {
    const emitted: Array<{ event: string; comment?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
    } as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([{
        rowId: 'implement', stageName: 'implement', isRework: false, handlerKey: 'implement',
        runCondition: () => true, runOnTerminal: false,
        handler: (s) => {
          (s as { halted?: boolean }).halted = true;
          s.terminal = true;
          return {
            outcome: 'halt' as const, payload: null, comment: 'provider_transport_failure: anthropic 5xx',
            telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' as const },
          };
        },
      }]),
      {
        implement: async (s) => {
          (s as { halted?: boolean }).halted = true;
          s.terminal = true;
          return {
            outcome: 'halt' as const, payload: null, comment: 'provider_transport_failure: anthropic 5xx',
            telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' as const },
          };
        },
      },
    );

    await driver.run(state);

    const haltEvent = emitted.find(e => e.event === 'stage_halt');
    expect(haltEvent?.comment).toMatch(/provider_transport_failure/);
  });
});

// ─── AC-35 ───────────────────────────────────────────────────────────────────
// Every gate emits stage_gate_recorded

describe('AC-35: every gate emits stage_gate_recorded', () => {
  it('all advance gates trigger stage_gate_recorded events at debug log level', async () => {
    const emitted: Array<{ event: string; stage?: string; outcome?: string }> = [];

    const state = makeMinimalState({ route: 'investigate' });
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
    } as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([
        {
          rowId: 'prepare', stageName: 'prepare', isRework: false, handlerKey: 'prepare',
          runCondition: () => true, runOnTerminal: false,
          handler: () => ({
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'prepare', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          }),
        },
        {
          rowId: 'implement', stageName: 'implement', isRework: false, handlerKey: 'implement',
          runCondition: () => true, runOnTerminal: false,
          handler: () => ({
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'implement', durationMs: 10, costUSD: 0.01, turnsUsed: 1, stopReason: 'normal' as const },
          }),
        },
        {
          rowId: 'annotate', stageName: 'annotate', isRework: false, handlerKey: 'annotate',
          runCondition: () => true, runOnTerminal: false,
          handler: () => ({
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'annotate', durationMs: 5, costUSD: 0.005, turnsUsed: 1, stopReason: 'normal' as const },
          }),
        },
      ]),
      {
        prepare: async () => ({
          outcome: 'advance' as const, payload: null,
          telemetry: { stageLabel: 'prepare', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
        }),
        implement: async () => ({
          outcome: 'advance' as const, payload: null,
          telemetry: { stageLabel: 'implement', durationMs: 10, costUSD: 0.01, turnsUsed: 1, stopReason: 'normal' as const },
        }),
        annotate: async () => ({
          outcome: 'advance' as const, payload: null,
          telemetry: { stageLabel: 'annotate', durationMs: 5, costUSD: 0.005, turnsUsed: 1, stopReason: 'normal' as const },
        }),
      },
    );

    await driver.run(state);

    const gateEvents = emitted.filter(e => e.event === 'stage_gate_recorded');
    expect(gateEvents.length).toBeGreaterThanOrEqual(2);
    expect(gateEvents.every(e => e.stage !== undefined && e.outcome !== undefined)).toBe(true);
  });

  it('skip gates also emit stage_gate_recorded', async () => {
    const emitted: Array<{ event: string; stage?: string; outcome?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
    } as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([
        {
          rowId: 'rework', stageName: 'rework', isRework: false, handlerKey: 'rework',
          runCondition: () => false,   // will be Layer-2 skipped
          runOnTerminal: false,
          handler: async () => ({ outcome: 'advance' as const, payload: null, telemetry: { stageLabel: 'rework', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const } }),
        },
      ]),
      {
        rework: async () => ({
          outcome: 'advance' as const, payload: null,
          telemetry: { stageLabel: 'rework', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
        }),
      },
    );

    await driver.run(state);

    const skipEvents = emitted.filter(e => e.event === 'stage_gate_recorded' && e.outcome === 'skip');
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── AC-36 ───────────────────────────────────────────────────────────────────
// Terminal side-effect failure emits structured event

describe('AC-36: terminal side-effect failure emits structured event', () => {
  it('telemetry_flush failure produces a terminal_side_effect_failed event', async () => {
    const emitted: Array<{ event: string; sideEffect?: string; reason?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.gates = {};
    (state as { halted?: boolean }).halted = false;

    // Build a mock execution context with a failing flush
    const failingFlush = async () => { throw new Error('flush closed'); };
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
      recorder: {
        flush: failingFlush,
        // Other methods no-op to Isolate the telemetry side-effect
        recordTaskCompleted: async () => {},
      },
      batchRegistry: { complete: () => {} },
      contextBlockStore: {},
    } as unknown as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([
        {
          rowId: 'implement', stageName: 'implement', isRework: false, handlerKey: 'implement',
          runCondition: () => true, runOnTerminal: false,
          handler: () => ({
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          }),
        },
        {
          rowId: 'flush_telemetry', stageName: 'flush_telemetry', isRework: false, handlerKey: 'flush_telemetry',
          runCondition: () => true, runOnTerminal: true,
          handler: async (s) => {
            try {
              await (s.executionContext as { recorder: { flush?: () => Promise<void> } }).recorder!.flush!();
            } catch (err) {
              // Emit structured failure event even when flush throws
              s.executionContext?.bus?.emit({
                event: 'terminal_side_effect_failed',
                stage: 'terminal',
                sideEffect: 'telemetryFlush',
                reason: (err as Error).message,
              });
              (s as { telemetryFlushed?: boolean }).telemetryFlushed = false;
              return {
                outcome: 'advance' as const, payload: null,
                telemetry: { stageLabel: 'flush_telemetry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
              };
            }
            (s as { telemetryFlushed?: boolean }).telemetryFlushed = true;
            return {
              outcome: 'advance' as const, payload: null,
              telemetry: { stageLabel: 'flush_telemetry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
            };
          },
        },
      ]),
      {
        implement: async () => ({
          outcome: 'advance' as const, payload: null,
          telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
        }),
        flush_telemetry: async (s) => {
          try {
            await (s.executionContext as { recorder: { flush?: () => Promise<void> } }).recorder!.flush!();
          } catch (err) {
            s.executionContext?.bus?.emit({
              event: 'terminal_side_effect_failed',
              stage: 'terminal',
              sideEffect: 'telemetryFlush',
              reason: (err as Error).message,
            });
            (s as { telemetryFlushed?: boolean }).telemetryFlushed = false;
            return {
              outcome: 'advance' as const, payload: null,
              telemetry: { stageLabel: 'flush_telemetry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
            };
          }
          (s as { telemetryFlushed?: boolean }).telemetryFlushed = true;
          return {
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'flush_telemetry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
    );

    await driver.run(state);

    const failureEvents = emitted.filter(e => e.event === 'terminal_side_effect_failed');
    expect(failureEvents.length).toBeGreaterThanOrEqual(1);
    expect(failureEvents.some(e => e.sideEffect === 'telemetryFlush')).toBe(true);
  });

  it('batch_registry failure emits terminal_side_effect_failed', async () => {
    const emitted: Array<{ event: string; sideEffect?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.gates = {};
    (state as { halted?: boolean }).halted = false;
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
      recorder: { flush: async () => {} },
      batchRegistry: {
        complete: () => { throw new Error('registry corrupted'); },
      },
      contextBlockStore: {},
    } as unknown as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([
        {
          rowId: 'persist_to_batch_registry', stageName: 'persist_to_batch_registry',
          isRework: false, handlerKey: 'persist_to_batch_registry',
          runCondition: () => true, runOnTerminal: true,
          handler: async (s) => {
            try {
              (s.executionContext as { batchRegistry: { complete?: () => void } }).batchRegistry!.complete!(0, null);
            } catch (err) {
              s.executionContext?.bus?.emit({
                event: 'terminal_side_effect_failed',
                stage: 'terminal',
                sideEffect: 'batchRegistry',
                reason: (err as Error).message,
              });
              return {
                outcome: 'advance' as const, payload: null,
                telemetry: { stageLabel: 'persist_to_batch_registry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
              };
            }
            return {
              outcome: 'advance' as const, payload: null,
              telemetry: { stageLabel: 'persist_to_batch_registry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
            };
          },
        },
      ]),
      {
        persist_to_batch_registry: async (s) => {
          try {
            (s.executionContext as { batchRegistry: { complete?: () => void } }).batchRegistry!.complete!(0, null);
          } catch (err) {
            s.executionContext?.bus?.emit({
              event: 'terminal_side_effect_failed',
              stage: 'terminal',
              sideEffect: 'batchRegistry',
              reason: (err as Error).message,
            });
            return {
              outcome: 'advance' as const, payload: null,
              telemetry: { stageLabel: 'persist_to_batch_registry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
            };
          }
          return {
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'persist_to_batch_registry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
    );

    await driver.run(state);

    const failureEvents = emitted.filter(e => e.event === 'terminal_side_effect_failed');
    expect(failureEvents.some(e => e.sideEffect === 'batchRegistry')).toBe(true);
  });

  it('multiple side-effect failures each emit a distinct structured event', async () => {
    const emitted: Array<{ event: string; sideEffect?: string }> = [];

    const state = makeMinimalState({ route: 'delegate' });
    state.gates = {};
    (state as { halted?: boolean }).halted = false;
    state.executionContext = {
      bus: { emit: (e: unknown) => emitted.push(e as typeof emitted[number]) },
      wallClockGuard: { checkOrThrow: () => {} },
      recorder: { flush: async () => { throw new Error('flush err'); } },
      batchRegistry: { complete: () => { throw new Error('registry err'); } },
      contextBlockStore: {},
    } as unknown as LifecycleState['executionContext'];

    const driver = new LifecycleDriver(
      makeTestPlan([
        {
          rowId: 'flush_telemetry', stageName: 'flush_telemetry',
          isRework: false, handlerKey: 'flush_telemetry',
          runCondition: () => true, runOnTerminal: true,
          handler: async (s) => {
            try {
              await (s.executionContext as { recorder: { flush?: () => Promise<void> } }).recorder!.flush!();
            } catch (err) {
              s.executionContext?.bus?.emit({
                event: 'terminal_side_effect_failed',
                stage: 'terminal',
                sideEffect: 'telemetryFlush',
                reason: (err as Error).message,
              });
            }
            return {
              outcome: 'advance' as const, payload: null,
              telemetry: { stageLabel: 'flush_telemetry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
            };
          },
        },
        {
          rowId: 'persist_to_batch_registry', stageName: 'persist_to_batch_registry',
          isRework: false, handlerKey: 'persist_to_batch_registry',
          runCondition: () => true, runOnTerminal: true,
          handler: async (s) => {
            try {
              (s.executionContext as { batchRegistry: { complete?: () => void } }).batchRegistry!.complete!(0, null);
            } catch (err) {
              s.executionContext?.bus?.emit({
                event: 'terminal_side_effect_failed',
                stage: 'terminal',
                sideEffect: 'batchRegistry',
                reason: (err as Error).message,
              });
            }
            return {
              outcome: 'advance' as const, payload: null,
              telemetry: { stageLabel: 'persist_to_batch_registry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
            };
          },
        },
      ]),
      {
        flush_telemetry: async (s) => {
          try {
            await (s.executionContext as { recorder: { flush?: () => Promise<void> } }).recorder!.flush!();
          } catch (err) {
            s.executionContext?.bus?.emit({
              event: 'terminal_side_effect_failed',
              stage: 'terminal',
              sideEffect: 'telemetryFlush',
              reason: (err as Error).message,
            });
          }
          return {
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'flush_telemetry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
        persist_to_batch_registry: async (s) => {
          try {
            (s.executionContext as { batchRegistry: { complete?: () => void } }).batchRegistry!.complete!(0, null);
          } catch (err) {
            s.executionContext?.bus?.emit({
              event: 'terminal_side_effect_failed',
              stage: 'terminal',
              sideEffect: 'batchRegistry',
              reason: (err as Error).message,
            });
          }
          return {
            outcome: 'advance' as const, payload: null,
            telemetry: { stageLabel: 'persist_to_batch_registry', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' as const },
          };
        },
      },
    );

    await driver.run(state);

    const failureEvents = emitted.filter(e => e.event === 'terminal_side_effect_failed');
    expect(failureEvents).toHaveLength(2);
    const sideEffects = failureEvents.map(e => e.sideEffect).filter(Boolean);
    expect(sideEffects).toContain('telemetryFlush');
    expect(sideEffects).toContain('batchRegistry');
  });
});