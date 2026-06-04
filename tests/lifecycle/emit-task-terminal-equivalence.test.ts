// Characterization test for emitTaskTerminalHandler — locks its observable
// contract before/after removing the dead telemetry aggregation. The handler's
// only observable effects are: (1) the taskTerminalEmitted idempotency flag,
// (2) it makes NO bus.emit call (the event moved to envelope.seal()).
import { describe, it, expect, vi } from 'vitest';
import { emitTaskTerminalHandler } from '../../packages/core/src/lifecycle/handlers/terminal-handlers.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function stateWith(opts: { ctx?: boolean; bus?: boolean; lastRunResult?: unknown }): { state: LifecycleState; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  const executionContext = opts.ctx === false ? undefined : ({ bus: opts.bus === false ? undefined : { emit } } as unknown);
  const state = { executionContext, lastRunResult: opts.lastRunResult } as unknown as LifecycleState;
  return { state, emit };
}

describe('emitTaskTerminalHandler — observable contract', () => {
  it('sets taskTerminalEmitted and emits NOTHING on the bus (ctx + bus present)', () => {
    const { state, emit } = stateWith({
      lastRunResult: { stageStats: { implement: { entered: true, inputTokens: 10, outputTokens: 5, costUSD: 0.01, turnCount: 1 } }, usage: { inputTokens: 10, outputTokens: 5 }, turns: 1, filesWritten: ['a.ts'] },
    });
    emitTaskTerminalHandler(state);
    expect((state as { taskTerminalEmitted?: boolean }).taskTerminalEmitted).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('is idempotent — second call is a no-op', () => {
    const { state, emit } = stateWith({});
    emitTaskTerminalHandler(state);
    emitTaskTerminalHandler(state);
    expect((state as { taskTerminalEmitted?: boolean }).taskTerminalEmitted).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not set the flag when executionContext is absent', () => {
    const { state } = stateWith({ ctx: false });
    emitTaskTerminalHandler(state);
    expect((state as { taskTerminalEmitted?: boolean }).taskTerminalEmitted).toBeUndefined();
  });

  it('sets the flag when ctx present but bus absent', () => {
    const { state } = stateWith({ bus: false });
    emitTaskTerminalHandler(state);
    expect((state as { taskTerminalEmitted?: boolean }).taskTerminalEmitted).toBe(true);
  });
});
