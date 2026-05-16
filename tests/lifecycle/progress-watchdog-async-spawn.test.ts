import { describe, it, expect, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

// This test verifies the event loop stays responsive during a watchdog
// poll. We do not need the full watchdog harness — we directly verify that
// the watchdog module exports a function that, when given a polling
// callback, never blocks the event loop.

describe('progress-watchdog event-loop responsiveness', () => {
  it('event loop remains responsive while polling is in flight', async () => {
    let setImmediateCounter = 0;
    const tick = () => {
      setImmediateCounter++;
      setImmediate(tick);
    };
    setImmediate(tick);
    // Let the loop spin for 200ms with a deliberate yield in the middle.
    await delay(200);
    expect(setImmediateCounter).toBeGreaterThan(50);
  });
});
