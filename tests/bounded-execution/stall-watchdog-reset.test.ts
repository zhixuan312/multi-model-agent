import { describe, it, expect } from 'bun:test';
import { startStallWatchdog } from '../../packages/core/src/bounded-execution/stall-watchdog.js';
import { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';
import { mapProviderEventToPlainEntry } from '../../packages/core/src/events/plain-log-entry.js';

// Regression: the watchdog stopped subscribing to provider progress events,
// so `lastEventAtMs` was set once at task start and never refreshed — turning
// the idle detector into a hard deadline that aborts active long-running tasks.
describe('stall watchdog — provider-event reset', () => {
  function makeStall() {
    return { controller: new AbortController(), lastEventAtMs: 1000, fired: false };
  }

  it('resets lastEventAtMs when a matching provider progress event arrives', () => {
    const bus = new EnvelopeBus();
    const stall = makeStall();
    const stop = startStallWatchdog({
      stall,
      timing: { stallTimeoutMs: 60_000 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    bus.emitPlainEntry(
      mapProviderEventToPlainEntry('claude', 'claude_tool_call', {
        tool: 'Read',
        batchId: 'task-A',
        taskIndex: 0,
      }),
    );
    stop();

    expect(stall.lastEventAtMs).toBeGreaterThan(1000);
  });

  it('ignores provider events belonging to a different task', () => {
    const bus = new EnvelopeBus();
    const stall = makeStall();
    const stop = startStallWatchdog({
      stall,
      timing: { stallTimeoutMs: 60_000 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    bus.emitPlainEntry(
      mapProviderEventToPlainEntry('claude', 'claude_tool_call', {
        tool: 'Read',
        batchId: 'task-B',
        taskIndex: 0,
      }),
    );
    stop();

    expect(stall.lastEventAtMs).toBe(1000);
  });

  it('ignores provider events that do not prove progress', () => {
    const bus = new EnvelopeBus();
    const stall = makeStall();
    const stop = startStallWatchdog({
      stall,
      timing: { stallTimeoutMs: 60_000 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });

    // claude_session_closed is a real provider event but not a progress signal.
    bus.emitPlainEntry(
      mapProviderEventToPlainEntry('claude', 'claude_session_closed', {
        batchId: 'task-A',
        taskIndex: 0,
      }),
    );
    stop();

    expect(stall.lastEventAtMs).toBe(1000);
  });

  it('stops resetting after the disposer is called', () => {
    const bus = new EnvelopeBus();
    const stall = makeStall();
    const stop = startStallWatchdog({
      stall,
      timing: { stallTimeoutMs: 60_000 },
      bus,
      batchId: 'task-A',
      taskIndex: 0,
    });
    stop();

    bus.emitPlainEntry(
      mapProviderEventToPlainEntry('claude', 'claude_turn_started', {
        batchId: 'task-A',
        taskIndex: 0,
      }),
    );

    expect(stall.lastEventAtMs).toBe(1000);
  });
});
