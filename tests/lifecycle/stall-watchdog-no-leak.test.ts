import { describe, it, expect } from 'vitest';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';
import { startStallWatchdog } from '../../packages/core/src/bounded-execution/stall-watchdog.js';

describe('stall-watchdog listener cleanup', () => {
  it('disposer removes the bus listener that resets lastEventAtMs', () => {
    const bus = new EventEmitter();
    const ctx = {
      stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
      timing: { stallTimeoutMs: 60_000 },
      bus,
    };

    // Snapshot baseline (the watchdog also adds its own `stall_watchdog_armed` listener-side effect, none).
    const baselineListeners = (bus as unknown as { listeners: unknown[] }).listeners.length;

    const dispose1 = startStallWatchdog(ctx);
    const dispose2 = startStallWatchdog(ctx);
    const dispose3 = startStallWatchdog(ctx);

    const afterArm = (bus as unknown as { listeners: unknown[] }).listeners.length;
    expect(afterArm - baselineListeners).toBe(3);

    dispose1();
    dispose2();
    dispose3();

    const afterDispose = (bus as unknown as { listeners: unknown[] }).listeners.length;
    expect(afterDispose).toBe(baselineListeners);
  });
});
