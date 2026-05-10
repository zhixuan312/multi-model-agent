import { describe, it, expect, vi } from 'vitest';
import { startStallWatchdog } from '../../packages/core/src/bounded-execution/stall-watchdog.js';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';

describe('startStallWatchdog', () => {
  it('aborts the controller when no events arrive within stallTimeoutMs', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    const ctx = {
      stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
      timing: { stallTimeoutMs: 1000 },
      bus: new EventEmitter(),
    };
    const dispose = startStallWatchdog(ctx);
    expect(ctx.stall.controller.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.stall.controller.signal.aborted).toBe(true);
    expect(ctx.stall.fired).toBe(true);
    dispose();
    vi.useRealTimers();
  });

  it('does not abort when reset events keep arriving', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    const bus = new EventEmitter();
    const ctx = {
      stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
      timing: { stallTimeoutMs: 1000 },
      bus,
    };
    const dispose = startStallWatchdog(ctx);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500);
      bus.emit({ event: 'runner_turn_started', ts: new Date().toISOString() });
    }
    expect(ctx.stall.controller.signal.aborted).toBe(false);
    dispose();
    vi.useRealTimers();
  });

  it('ignores unrelated events for the reset', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    const bus = new EventEmitter();
    const ctx = {
      stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
      timing: { stallTimeoutMs: 1000 },
      bus,
    };
    const dispose = startStallWatchdog(ctx);

    // Emit unrelated events; clock keeps advancing without reset
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(400);
      bus.emit({ event: 'some_unrelated_event', ts: new Date().toISOString() });
    }
    // 1200ms elapsed > 1000ms stallTimeoutMs -> watchdog should fire
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.stall.controller.signal.aborted).toBe(true);
    dispose();
    vi.useRealTimers();
  });

  it('dispose() stops the timer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
    const ctx = {
      stall: { controller: new AbortController(), lastEventAtMs: Date.now(), fired: false },
      timing: { stallTimeoutMs: 1000 },
      bus: new EventEmitter(),
    };
    const dispose = startStallWatchdog(ctx);
    dispose();

    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.stall.controller.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});
