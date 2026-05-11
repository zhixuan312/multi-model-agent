import { describe, it, expect } from 'vitest';
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
      tasks: [{ state: 'implementing', stageInfo: 'Complex worker (1/3)', filesRead: 9, filesWritten: 0, toolCalls: 9 }],
      elapsedMs: 254_000,
    });
    expect(out).toMatch(/^\[1\/1\] Implementing by Complex worker \(1\/3\) - 4m 14s, 9 read, 0 write, 9 tool calls/);
  });

  it('N=4 all running: uses [N/N] running <elapsed> top line + 4 indented per-task lines, 1-indexed', () => {
    const out = composeRunningHeadline({
      tasks: [
        { state: 'implementing', stageInfo: 'Complex worker (1/3)', filesRead: 12, filesWritten: 8, toolCalls: 20 },
        { state: 'implementing', stageInfo: 'Complex worker (1/3)', filesRead: 9, filesWritten: 0, toolCalls: 9 },
        { state: 'reviewing',    stageInfo: 'Complex worker (1/3)', filesRead: 5, filesWritten: 0, toolCalls: 5 },
        { state: 'error',        errorMessage: 'provider_transport_failure' },
      ],
      elapsedMs: 254_000,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('[4/4] running 4m 14s');
    expect(lines[1]).toMatch(/^  \[1\] Implementing by Complex worker \(1\/3\) - 12 read, 8 write, 20 tool calls$/);
    expect(lines[2]).toMatch(/^  \[2\] Implementing by Complex worker \(1\/3\) - 9 read, 0 write, 9 tool calls$/);
    expect(lines[3]).toMatch(/^  \[3\] Reviewing by Complex worker \(1\/3\) - 5 read, 0 write, 5 tool calls$/);
    expect(lines[4]).toMatch(/^  \[4\] error: provider_transport_failure$/);
  });

  it('N=4 mixed (some done, some running): top line uses [<doneCount>/N done] running <elapsed>', () => {
    const out = composeRunningHeadline({
      tasks: [
        { state: 'done', filesWritten: 2, files: ['src/foo.ts', 'src/bar.ts'], filesRead: 12, toolCalls: 20 },
        { state: 'done', filesWritten: 1, files: ['src/baz.ts'], filesRead: 9, toolCalls: 9 },
        { state: 'implementing', stageInfo: 'Complex worker (2/3)', filesRead: 22, filesWritten: 0, toolCalls: 22 },
        { state: 'error', errorMessage: 'provider_transport_failure' },
      ],
      elapsedMs: 482_000,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('[2/4 done] running 8m 2s');
    expect(lines[1]).toMatch(/^  \[1\] done — 12 read, 20 tool calls — files: src\/foo\.ts, src\/bar\.ts$/);
    expect(lines[2]).toMatch(/^  \[2\] done — 9 read, 9 tool calls — files: src\/baz\.ts$/);
    expect(lines[3]).toMatch(/^  \[3\] Implementing by Complex worker \(2\/3\) - 22 read, 0 write, 22 tool calls$/);
    expect(lines[4]).toMatch(/^  \[4\] error: provider_transport_failure$/);
  });
});
