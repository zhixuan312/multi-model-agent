import { describe, it, expect } from 'bun:test';
import { startStallWatchdog } from '../../../packages/core/src/bounded-execution/stall-watchdog.js';
import { EnvelopeBus } from '../../../packages/core/src/events/envelope-bus.js';
import type { Subscriber, BusMessage } from '../../../packages/core/src/events/envelope-bus.js';

describe('stall watchdog', () => {
  // Watchdog poll interval is clamped to [1000, 5000]ms, so any "should fire"
  // test must wait ≥ stallTimeoutMs + pollInterval + buffer.
  it('emits stall_watchdog_armed on startup', async () => {
    const bus = new EnvelopeBus();
    const ctlA = new AbortController();
    const stallA = { controller: ctlA, lastEventAtMs: Date.now(), fired: false };

    const capturedMessages: BusMessage[] = [];
    const testSink: Subscriber = {
      name: 'test-sink',
      receive: (msg) => capturedMessages.push(msg),
    };
    bus.subscribe(testSink);

    const stop = startStallWatchdog({
      stall: stallA,
      timing: { stallTimeoutMs: 500 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    stop();

    // Verify that stall_watchdog_armed was emitted as a plain entry
    const armedEntry = capturedMessages.find(
      (m) => m.type === 'plain' && m.entry.kind === 'stall_watchdog_armed',
    );
    expect(armedEntry).toBeDefined();
    if (armedEntry && armedEntry.type === 'plain') {
      expect(armedEntry.entry.fields.task_id).toBe('task-A:0');
      expect(armedEntry.entry.fields.idle_threshold_ms).toBe(500);
    }
  });

  it('fires and emits stall_watchdog_fired when idle timeout exceeded', async () => {
    const bus = new EnvelopeBus();
    const ctlA = new AbortController();
    const stallA = { controller: ctlA, lastEventAtMs: Date.now(), fired: false };

    const capturedMessages: BusMessage[] = [];
    const testSink: Subscriber = {
      name: 'test-sink',
      receive: (msg) => capturedMessages.push(msg),
    };
    bus.subscribe(testSink);

    const stop = startStallWatchdog({
      stall: stallA,
      timing: { stallTimeoutMs: 500 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    // Wait ≥ stallTimeoutMs (500) + pollInterval (1000) + buffer = ~1800ms.
    await new Promise((r) => setTimeout(r, 1800));
    stop();

    expect(ctlA.signal.aborted).toBe(true);
    expect(stallA.fired).toBe(true);
    // Verify that stall_watchdog_fired was emitted as a plain entry
    const stallFiredEntry = capturedMessages.find(
      (m) => m.type === 'plain' && m.entry.kind === 'stall_watchdog_fired',
    );
    expect(stallFiredEntry).toBeDefined();
    if (stallFiredEntry && stallFiredEntry.type === 'plain') {
      expect(stallFiredEntry.entry.fields.task_id).toBe('task-A:0');
      expect(typeof stallFiredEntry.entry.fields.idle_ms_observed).toBe('number');
    }
  }, 5000);
});
