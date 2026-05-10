import { describe, it, expect } from 'vitest';
import { RunningHeadlineSink } from '../../packages/core/src/events/running-headline-sink.js';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';

/**
 * A4b.0 (4.2.2+) — when the runner-shell emits per-turn `pathsReadThisTurn`
 * and `pathsWrittenThisTurn` arrays on `runner_turn_completed`, the sink
 * must dedupe by path across turns. Same path written N times in N turns
 * = `1 write` in the headline, NOT `N write`.
 *
 * Live observation that motivated this (2026-05-10): a task that wrote
 * 3 unique files reported "10 write, 36 tool calls" because every
 * write_file invocation incremented the count.
 */
describe('A4b.0 — RunningHeadlineSink dedupes reads/writes by path', () => {
  function setupSink() {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b1',
      projectCwd: '/tmp/x',
      tool: 'delegate',
      state: 'pending',
      startedAt: Date.now(),
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
    });
    return { registry, sink: new RunningHeadlineSink(registry) };
  }

  function emitTurn(
    sink: RunningHeadlineSink,
    pathsRead: string[],
    pathsWritten: string[],
    toolCallCount: number,
  ): void {
    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount,
      pathsReadThisTurn: pathsRead,
      pathsWrittenThisTurn: pathsWritten,
    });
  }

  it('5 writes to the same path across 5 turns → headline shows 1 write', () => {
    const { registry, sink } = setupSink();
    for (let i = 0; i < 5; i++) emitTurn(sink, [], ['src/foo.ts'], 1);
    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('0 read, 1 write, 5 tool calls');
  });

  it('writes to two different paths across turns → headline shows 2 write', () => {
    const { registry, sink } = setupSink();
    emitTurn(sink, [], ['a.ts'], 1);
    emitTurn(sink, [], ['b.ts'], 1);
    emitTurn(sink, [], ['a.ts'], 1); // dup
    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('0 read, 2 write, 3 tool calls');
  });

  it('mixed reads and writes both dedupe independently', () => {
    const { registry, sink } = setupSink();
    emitTurn(sink, ['plan.md', 'spec.md'], ['a.ts'], 3);
    emitTurn(sink, ['plan.md'], ['a.ts'], 2); // both dup
    emitTurn(sink, ['plan.md'], ['b.ts'], 2);
    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('2 read, 2 write, 7 tool calls');
  });

  it('shell writes still count via the existing shellWrites path', () => {
    const { registry, sink } = setupSink();
    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount: 1,
      pathsReadThisTurn: [],
      pathsWrittenThisTurn: [],
      shellWrites: 1,
    });
    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('0 read, 1 write, 1 tool calls');
  });

  it('legacy bucket-count form (toolCalls: {edit_file: 1}) still works for fixtures that send no paths', () => {
    const { registry, sink } = setupSink();
    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount: 1,
      toolCalls: { edit_file: 1 }, // no paths — bucket fallback
    });
    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('1 write, 1 tool calls');
  });
});
