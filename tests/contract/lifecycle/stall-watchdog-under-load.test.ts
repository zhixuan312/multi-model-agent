import { describe, it, expect } from 'vitest';
import { startStallWatchdog } from '../../../packages/core/src/bounded-execution/stall-watchdog.js';
import { EventEmitter } from '@zhixuan92/multi-model-agent-core';

describe('stall watchdog filters by task identity', () => {
  // Watchdog poll interval is clamped to [1000, 5000]ms, so any "should fire"
  // test must wait ≥ stallTimeoutMs + pollInterval + buffer.
  it('fires for task A even when task B emits progress events on the same bus', async () => {
    const bus = new EventEmitter([]);
    const ctlA = new AbortController();
    const stallA = { controller: ctlA, lastEventAtMs: Date.now(), fired: false };
    const stop = startStallWatchdog({
      stall: stallA,
      timing: { stallTimeoutMs: 500 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    // Every 100ms emit a turn-completed event for a different task (task-B)
    const interval = setInterval(() => {
      bus.emit({
        event: 'codex_turn_completed',
        ts: new Date().toISOString(),
        batchId: 'task-B',
        taskIndex: 0,
      });
    }, 100);

    // Wait ≥ stallTimeoutMs (500) + pollInterval (1000) + buffer = ~1800ms.
    await new Promise((r) => setTimeout(r, 1800));
    clearInterval(interval);
    stop();

    expect(ctlA.signal.aborted).toBe(true);
    expect(stallA.fired).toBe(true);
  }, 5000);

  it('does NOT fire for task A when task A itself emits progress events', async () => {
    const bus = new EventEmitter([]);
    const ctlA = new AbortController();
    const stallA = { controller: ctlA, lastEventAtMs: Date.now(), fired: false };
    const stop = startStallWatchdog({
      stall: stallA,
      timing: { stallTimeoutMs: 500 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    // Emit progress for task-A faster than stallTimeoutMs — should keep watchdog quiet.
    const interval = setInterval(() => {
      bus.emit({
        event: 'codex_turn_completed',
        ts: new Date().toISOString(),
        batchId: 'task-A',
        taskIndex: 0,
      });
    }, 100);

    await new Promise((r) => setTimeout(r, 1800));
    clearInterval(interval);
    stop();

    expect(ctlA.signal.aborted).toBe(false);
    expect(stallA.fired).toBe(false);
  }, 5000);
});
