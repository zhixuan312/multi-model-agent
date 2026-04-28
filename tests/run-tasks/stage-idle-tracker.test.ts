import { describe, it, expect, vi } from 'vitest';
import { newStageIdleTracker, snapshotIdle } from '../../packages/core/src/run-tasks/stage-idle-tracker.js';

describe('StageIdleTracker', () => {
  it('records max gap, sum of gaps >1s, and event count', () => {
    const T0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(T0);
    const tracker = newStageIdleTracker(T0);
    const fire = (deltaFromStart: number): void => {
      nowSpy.mockReturnValue(T0 + deltaFromStart);
      const now = Date.now();
      const gap = now - tracker.stageLastEventMs;
      if (gap > tracker.stageMaxIdleMs) tracker.stageMaxIdleMs = gap;
      if (gap > 1000) tracker.stageTotalIdleMs += gap;
      tracker.stageActivityCount += 1;
      tracker.stageLastEventMs = now;
    };
    fire(100);    // gap 100ms — below 1s threshold
    fire(5100);   // gap 5000ms
    fire(5300);   // gap 200ms — below threshold
    fire(35300);  // gap 30000ms
    expect(tracker.stageActivityCount).toBe(4);
    expect(tracker.stageMaxIdleMs).toBe(30000);
    expect(tracker.stageTotalIdleMs).toBe(35000); // 5000 + 30000
    expect(snapshotIdle(tracker)).toEqual({ maxIdleMs: 30000, totalIdleMs: 35000, activityEvents: 4 });
    nowSpy.mockRestore();
  });
});
