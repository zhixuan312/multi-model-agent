import { describe, it, expect } from 'vitest';
import { composeRunningHeadline } from '@zhixuan92/multi-model-agent-core';

describe('composeRunningHeadline', () => {
  it('1 task queued', () => {
    expect(composeRunningHeadline({
      tasksTotal: 1, tasksStarted: 0, tasksCompleted: 0,
      startedAt: 0, nowMs: 5_000,
      lastHeartbeatAt: 0,
      running: [],
    })).toBe('1/1 queued, 5s elapsed');
  });

  it('1 task running with worker + turn', () => {
    expect(composeRunningHeadline({
      tasksTotal: 1, tasksStarted: 1, tasksCompleted: 0,
      startedAt: 0, nowMs: 47_000,
      lastHeartbeatAt: 42_000,
      running: [{ worker: 'MiniMax-M2.7', turn: 2 }],
    })).toBe('1/1 running, 47s elapsed, worker: MiniMax-M2.7 (turn 2)');
  });

  it('multi-task batch', () => {
    expect(composeRunningHeadline({
      tasksTotal: 7, tasksStarted: 5, tasksCompleted: 3,
      startedAt: 0, nowMs: 124_000,
      lastHeartbeatAt: 120_000,
      running: [{ worker: 'MiniMax', turn: 1 }, { worker: 'claude', turn: 1 }],
    })).toBe('3/7 complete, 2 running, 124s elapsed');
  });

  it('stall clause appears past 2× heartbeat interval', () => {
    const out = composeRunningHeadline({
      tasksTotal: 1, tasksStarted: 1, tasksCompleted: 0,
      startedAt: 0, nowMs: 78_000,
      lastHeartbeatAt: 46_000,
      running: [{ worker: 'MiniMax-M2.7', turn: 1 }],
      heartbeatIntervalMs: 15_000,
    });
    expect(out).toMatch(/stalled: no heartbeat for 3[2-3]s/);
    expect(out).toMatch(/1\/1 running/);
  });
});
