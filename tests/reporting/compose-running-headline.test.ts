import { describe, it, expect } from 'bun:test';
import { composeRunningHeadline } from '../../packages/core/src/reporting/compose-running-headline.js';

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

describe('composeRunningHeadline N>1 multi-line format (A7)', () => {
  it('N=1 unchanged: keeps single-line format with timing on the same line', () => {
    const out = composeRunningHeadline({
      tasks: [{ state: 'implementing', stageInfo: 'Complex worker (1/3)', filesWritten: 0, turns: 9 }],
      elapsedMs: 254_000,
    });
    expect(out).toMatch(/^\[1\/1\] Implementing by Complex worker \(1\/3\) - 4m 14s, 0 files written, 9 turns/);
  });

  it('N=4 all running: uses [N/N] running <elapsed> top line + 4 indented per-task lines, 1-indexed', () => {
    const out = composeRunningHeadline({
      tasks: [
        { state: 'implementing', stageInfo: 'Complex worker (1/3)', filesWritten: 8, turns: 20 },
        { state: 'implementing', stageInfo: 'Complex worker (1/3)', filesWritten: 0, turns: 9 },
        { state: 'reviewing',    stageInfo: 'Complex worker (1/3)', filesWritten: 0, turns: 5 },
        { state: 'error',        errorMessage: 'runner_crash' },
      ],
      elapsedMs: 254_000,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('[4/4] running 4m 14s');
    expect(lines[1]).toMatch(/^  \[1\] Implementing by Complex worker \(1\/3\) - 8 files written, 20 turns$/);
    expect(lines[2]).toMatch(/^  \[2\] Implementing by Complex worker \(1\/3\) - 0 files written, 9 turns$/);
    expect(lines[3]).toMatch(/^  \[3\] Reviewing by Complex worker \(1\/3\) - 0 files written, 5 turns$/);
    expect(lines[4]).toMatch(/^  \[4\] error: runner_crash$/);
  });

  it('N=4 mixed (some done, some running): top line uses [<doneCount>/N done] running <elapsed>', () => {
    const out = composeRunningHeadline({
      tasks: [
        { state: 'done', filesWritten: 2, files: ['src/foo.ts', 'src/bar.ts'] },
        { state: 'done', filesWritten: 1, files: ['src/baz.ts'] },
        { state: 'implementing', stageInfo: 'Complex worker (2/3)', filesWritten: 0, turns: 22 },
        { state: 'error', errorMessage: 'runner_crash' },
      ],
      elapsedMs: 482_000,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('[2/4 done] running 8m 2s');
    expect(lines[1]).toMatch(/^  \[1\] done — 2 files written — files: src\/foo\.ts, src\/bar\.ts$/);
    expect(lines[2]).toMatch(/^  \[2\] done — 1 files written — files: src\/baz\.ts$/);
    expect(lines[3]).toMatch(/^  \[3\] Implementing by Complex worker \(2\/3\) - 0 files written, 22 turns$/);
    expect(lines[4]).toMatch(/^  \[4\] error: runner_crash$/);
  });
});
