import { describe, it, expect } from 'vitest';
import { RunningHeadlineSink } from '../../packages/core/src/events/running-headline-sink.js';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';

/**
 * Gap 14 regression test (4.0.3+): the polling headline must increment
 * its `write` counter when the worker calls edit_file (not just
 * write_file / writeFile). Pre-fix the sink's WRITE_TOOLS was a
 * narrower copy that omitted edit_file, so the headline reported
 * "0 write" while runResult.filesWritten correctly carried the file
 * path. Single source of truth in providers/tool-name-sets.ts.
 */
describe('RunningHeadlineSink write attribution (Gap 14)', () => {
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

  it('counts edit_file as a write', () => {
    const { registry, sink } = setupSink();

    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount: 1,
      toolCalls: { edit_file: 1 },
    });

    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('1 write');
  });

  it('counts editFile (camelCase) as a write', () => {
    const { registry, sink } = setupSink();

    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount: 1,
      toolCalls: { editFile: 1 },
    });

    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('1 write');
  });

  it('counts write_file + edit_file together as 2 writes', () => {
    const { registry, sink } = setupSink();

    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount: 2,
      toolCalls: { write_file: 1, edit_file: 1 },
    });

    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('2 write');
  });

  it('does NOT count read_file / grep / glob as writes', () => {
    const { registry, sink } = setupSink();

    sink.emit({
      event: 'runner_turn_completed',
      ts: new Date().toISOString(),
      batchId: 'b1',
      taskIndex: 0,
      stageLabel: 'Implementing',
      tier: 'standard',
      toolCallCount: 5,
      toolCalls: { read_file: 2, grep: 2, glob: 1 },
    });

    const snap = registry.get('b1')!.runningHeadlineSnapshot;
    expect(snap.statsClause).toContain('0 write');
    expect(snap.statsClause).toContain('5 read');
  });
});
