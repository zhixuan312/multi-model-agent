import { describe, it, expect, vi } from 'vitest';
import { startProgressWatchdog } from '../../packages/core/src/bounded-execution/progress-watchdog.js';

function makeCtx(overrides: any = {}) {
  const state2 = { fired: false };
  const controller = new AbortController();
  const state: any = {
    cwd: '/tmp/fake',
    toolCategory: 'artifact_producing',
    preTaskHeadSha: 'fake-sha',
    preTaskUntrackedFiles: new Set(),
    task: { filePaths: [] },   // state.task per LifecycleState (no `taskSpec` field)
    ...overrides,
  };
  const emit = vi.fn();
  return { state, emit, controller, state2 };
}

describe('progress-watchdog', () => {
  it('no-ops when config.enabled is false', () => {
    const { state, emit, controller, state2 } = makeCtx();
    const dispose = startProgressWatchdog({
      state,
      emit,
      controller,
      state2,
      config: { enabled: false, thrashTurns: 25, thrashWallClockMs: 1200000, thrashSoftWallClockMs: 600000 },
      taskIndex: 0,
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'progress_watchdog_skipped_disabled' }));
    dispose();
    expect(state.thrashingDetected).toBeUndefined();
    expect(state.preStopReason).toBeUndefined();
  });

  it('no-ops on read-only routes', () => {
    const { state, emit, controller, state2 } = makeCtx({ toolCategory: 'read_only' });
    const dispose = startProgressWatchdog({
      state,
      emit,
      controller,
      state2,
      config: { enabled: true, thrashTurns: 25, thrashWallClockMs: 1200000, thrashSoftWallClockMs: 600000 },
      taskIndex: 0,
    });
    dispose();
    expect(state.thrashingDetected).toBeUndefined();
  });

  it('no-ops in non-git mode (no preTaskHeadSha)', () => {
    const { state, emit, controller, state2 } = makeCtx({ preTaskHeadSha: undefined });
    const dispose = startProgressWatchdog({
      state,
      emit,
      controller,
      state2,
      config: { enabled: true, thrashTurns: 25, thrashWallClockMs: 1200000, thrashSoftWallClockMs: 600000 },
      taskIndex: 0,
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'progress_watchdog_skipped_non_git' }));
    dispose();
    expect(state.thrashingDetected).toBeUndefined();
  });

  // For Signal 1 + 2 + 3 the test needs a real git repo so getRealFilesChanged works.
  // Mirror the makeRepo pattern from real-diff.test.ts.
  // ... add signal tests using a real tmp repo ...
});