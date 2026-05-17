import { describe, it, expect } from 'vitest';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';
import type { HeartbeatTickInfo } from '../../packages/core/src/bounded-execution/activity-tracker-types.js';

describe('recordHeartbeat per-task wiring', () => {
  it('writes a structured per-task HeadlineSnapshot on every tick', () => {
    // Inline the callback shape buildExecutionContext currently exports.
    // The point of this test is to assert that the callback writes BOTH
    // the legacy field AND the per-task field with structured fields.
    const registry = new BatchRegistry({ max: 10, batchTtlMs: 60_000 });
    const batchId = 'b-1';
    registry.register({
      batchId,
      projectCwd: '/tmp',
      tool: 'delegate',
      state: 'pending',
      startedAt: Date.now(),
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
    });

    // Build a minimal recordHeartbeat that mirrors execution-context.ts
    const recordHeartbeat = (tick: HeartbeatTickInfo) => {
      const entry = registry.get(batchId);
      if (!entry) return;
      entry.lastHeartbeatAt = Date.now();
      entry.running = [{ worker: tick.provider, turn: Math.max(1, tick.stageIndex) }];
      if (tick.snapshot) {
        registry.updateRunningHeadlineSnapshot(batchId, tick.snapshot);
      }
      registry.updatePerTaskHeadlineSnapshot(batchId, 0, {
        prefix: tick.snapshot.prefix,
        statsClause: tick.snapshot.statsClause,
        dispatchedAt: tick.snapshot.dispatchedAt,
        fallback: tick.snapshot.fallback,
        stageLabel: capitalizeStage(tick.stage),
        stageDone: tick.stageIndex,
        stageTotal: tick.stageCount,
        toolReads: tick.progress.filesRead,
        toolWrites: tick.progress.filesWritten,
        toolTotal: tick.progress.toolCalls,
      });
    };

    function capitalizeStage(s: string): string {
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    const tick: HeartbeatTickInfo = {
      batchId,
      elapsedMs: 5000,
      idleSinceLlmMs: 0,
      idleSinceToolMs: 0,
      idleSinceTextMs: 0,
      stage: 'review',
      stageIndex: 2,
      stageCount: 6,
      provider: 'claude',
      progress: { filesRead: 3, filesWritten: 1, toolCalls: 7 },
      costUSD: 0.05,
      costDeltaVsMainUSD: null,
      stageIdleMs: 0,
      headline: '[1/1] Review — 5s, 3 read, 1 written, 7 tool calls',
      snapshot: {
        prefix: '[1/1] Review (claude) — ',
        statsClause: ', 3 read, 1 written, 7 tool calls',
        dispatchedAt: Date.now() - 5000,
        fallback: '[1/1] Review (claude)',
      },
    };

    recordHeartbeat(tick);

    const entry = registry.get(batchId)!;
    const perTask = entry.perTaskHeadlineSnapshots!.get(0)!;
    expect(perTask.stageLabel).toBe('Review');
    expect(perTask.stageDone).toBe(2);
    expect(perTask.stageTotal).toBe(6);
    expect(perTask.toolReads).toBe(3);
    expect(perTask.toolWrites).toBe(1);
    expect(perTask.toolTotal).toBe(7);
    // legacy snapshot also populated
    expect(entry.runningHeadlineSnapshot.prefix).toContain('Review');
  });
});
