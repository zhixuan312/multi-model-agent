import { describe, it, expect, vi } from 'vitest';
import { ActivityTracker } from '../../packages/core/src/bounded-execution/activity-tracker.js';

describe('ActivityTracker', () => {
  it('emits at cadence', () => {
    vi.useFakeTimers();
    const sigs: any[] = [];
    const t = new ActivityTracker(1000, s => sigs.push(s));
    t.start();
    vi.advanceTimersByTime(3500);
    t.stop();
    expect(sigs.length).toBe(3);
    vi.useRealTimers();
  });
});
