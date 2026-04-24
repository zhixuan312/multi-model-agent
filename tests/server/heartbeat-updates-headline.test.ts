import { describe, it, expect } from 'vitest';
import {
  BatchRegistry,
  HeartbeatTimer,
  composeRunningHeadline,
  type HeartbeatTickInfo,
} from '@zhixuan92/multi-model-agent-core';

describe('heartbeat tick updates runningHeadline', () => {
  it('recordHeartbeat callback propagates recomposed headline to registry', () => {
    const reg = new BatchRegistry({ clarificationTimeoutMs: 60_000, batchTtlMs: 3_600_000 });
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

    // Simulate the server-side callback: compose from entry + push.
    const recordHeartbeat = (tick: HeartbeatTickInfo) => {
      const entry = reg.get(tick.batchId);
      if (!entry) return;
      const headline = composeRunningHeadline({
        tasksTotal: entry.tasksTotal ?? 1,
        tasksStarted: entry.tasksStarted ?? 0,
        tasksCompleted: entry.tasksCompleted ?? 0,
        startedAt: entry.startedAt,
        nowMs: Date.now(),
        lastHeartbeatAt: entry.lastHeartbeatAt ?? 0,
        running: entry.running ?? [],
      });
      reg.updateRunningHeadline(tick.batchId, headline);
    };

    const progressEvents: unknown[] = [];
    const timer = new HeartbeatTimer(
      (evt) => progressEvents.push(evt),
      { provider: 'MiniMax-M2.7', intervalMs: 50_000, recordHeartbeat, batchId: 'hb1' },
    );
    timer.start(1);
    timer.updateProgress(0, 0, 1);
    timer.transition({ stage: 'implementing', stageIndex: 1 }); // triggers emit
    timer.stop(); // final emit

    const updated = reg.get('hb1');
    expect(updated?.runningHeadline).toMatch(/1\/1 running/);
  });

  it('recordHeartbeat no-op when omitted', () => {
    const timer = new HeartbeatTimer(
      () => {},
      { provider: 'x', intervalMs: 50_000 },
    );
    timer.start(1);
    timer.transition({ stage: 'implementing', stageIndex: 1 });
    expect(() => timer.stop()).not.toThrow();
  });
});
