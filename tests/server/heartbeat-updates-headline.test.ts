import { describe, it, expect } from 'vitest';
import {
  BatchRegistry,
  ActivityTracker,
  type HeartbeatTickInfo,
} from '@zhixuan92/multi-model-agent-core';

describe('heartbeat tick updates runningHeadlineSnapshot', () => {
  it('recordHeartbeat callback propagates snapshot to registry', () => {
    const reg = new BatchRegistry({ batchTtlMs: 3_600_000 });
    const started = Date.now();
    reg.register({
      batchId: 'hb1', projectCwd: '/tmp', tool: 'delegate',
      state: 'pending', startedAt: started, stateChangedAt: started,
      blockIds: [], blocksReleased: false,
      tasksTotal: 1,
      tasksStarted: 1,
      tasksCompleted: 0,
      lastHeartbeatAt: started,
      running: [{ worker: 'MiniMax-M2.7', turn: 1 }],
    });

    const recordHeartbeat = (tick: HeartbeatTickInfo) => {
      if (tick.snapshot) {
        reg.updateRunningHeadlineSnapshot(tick.batchId, tick.snapshot);
      }
    };

    const progressEvents: unknown[] = [];
    const timer = new ActivityTracker(
      (evt) => progressEvents.push(evt),
      { provider: 'MiniMax-M2.7', intervalMs: 50_000, recordHeartbeat, batchId: 'hb1' },
    );
    timer.start(1);
    timer.updateProgress(0, 0, 1);
    timer.transition({ stage: 'implementing', stageIndex: 1 });
    timer.stop();

    const updated = reg.get('hb1');
    expect(updated?.runningHeadlineSnapshot.prefix).toMatch(/Implementing/);
  });

  it('recordHeartbeat no-op when omitted', () => {
    const timer = new ActivityTracker(
      () => {},
      { provider: 'x', intervalMs: 50_000 },
    );
    timer.start(1);
    timer.transition({ stage: 'implementing', stageIndex: 1 });
    expect(() => timer.stop()).not.toThrow();
  });
});
