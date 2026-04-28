export interface StageIdleTracker {
  stageStartMs:       number;
  stageLastEventMs:   number;
  stageMaxIdleMs:     number;
  stageTotalIdleMs:   number;
  stageActivityCount: number;
}

export function newStageIdleTracker(now: number): StageIdleTracker {
  return {
    stageStartMs: now,
    stageLastEventMs: now,
    stageMaxIdleMs: 0,
    stageTotalIdleMs: 0,
    stageActivityCount: 0,
  };
}

export function snapshotIdle(t: StageIdleTracker): { maxIdleMs: number; totalIdleMs: number; activityEvents: number } {
  return {
    maxIdleMs: t.stageMaxIdleMs,
    totalIdleMs: t.stageTotalIdleMs,
    activityEvents: t.stageActivityCount,
  };
}
