import { describe, it, expect } from 'vitest';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';
import type { HeartbeatTickInfo } from '../../packages/core/src/bounded-execution/activity-tracker-types.js';

describe('polling stage progression', () => {
  it('per-task headline snapshot advances as the tracker transitions stages', () => {
    const registry = new BatchRegistry({ max: 10, batchTtlMs: 60_000 });
    const batchId = 'b-acceptance';
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

    // Mimic the seed write that async-dispatch.ts:104 does
    registry.updatePerTaskHeadlineSnapshot(batchId, 0, {
      prefix: 'Implementing (1/6) - ',
      statsClause: '',
      dispatchedAt: Date.now(),
      fallback: 'Implementing (1/6)',
    });

    // Inlined callback shape — mirrors execution-context.ts after Task 1
    const recordHeartbeat = (tick: HeartbeatTickInfo) => {
      const entry = registry.get(batchId);
      if (!entry || !tick.snapshot) return;
      registry.updateRunningHeadlineSnapshot(batchId, tick.snapshot);
      registry.updatePerTaskHeadlineSnapshot(batchId, 0, {
        prefix: tick.snapshot.prefix,
        statsClause: tick.snapshot.statsClause,
        dispatchedAt: tick.snapshot.dispatchedAt,
        fallback: tick.snapshot.fallback,
        stageLabel: tick.stage.charAt(0).toUpperCase() + tick.stage.slice(1),
        stageDone: tick.stageIndex,
        stageTotal: tick.stageCount,
        toolReads: tick.progress.filesRead,
        toolWrites: tick.progress.filesWritten,
        toolTotal: tick.progress.toolCalls,
      });
    };

    const baseTick = (overrides: Partial<HeartbeatTickInfo>): HeartbeatTickInfo => ({
      batchId,
      elapsedMs: 1000,
      idleSinceLlmMs: 0,
      idleSinceToolMs: 0,
      idleSinceTextMs: 0,
      stage: 'implementing',
      stageIndex: 1,
      stageCount: 6,
      provider: 'claude',
      progress: { filesRead: 0, filesWritten: 0, toolCalls: 0 },
      costUSD: 0,
      costDeltaVsMainUSD: null,
      stageIdleMs: 0,
      headline: '',
      snapshot: {
        prefix: '',
        statsClause: '',
        dispatchedAt: Date.now(),
        fallback: '',
      },
      ...overrides,
    });

    // Implementing tick
    recordHeartbeat(baseTick({
      stage: 'implementing',
      stageIndex: 1,
      progress: { filesRead: 2, filesWritten: 1, toolCalls: 5 },
      snapshot: {
        prefix: '[1/1] Implementing (claude) — ',
        statsClause: ', 2 read, 1 written, 5 tool calls',
        dispatchedAt: Date.now() - 1000,
        fallback: '[1/1] Implementing (claude)',
      },
    }));
    let snap = registry.get(batchId)!.perTaskHeadlineSnapshots!.get(0)!;
    expect(snap.stageLabel).toBe('Implementing');
    expect(snap.toolReads).toBe(2);
    expect(snap.toolTotal).toBe(5);

    // Review tick
    recordHeartbeat(baseTick({
      stage: 'review',
      stageIndex: 2,
      progress: { filesRead: 3, filesWritten: 1, toolCalls: 8 },
      snapshot: {
        prefix: '[1/1] Review (claude) — ',
        statsClause: ', 3 read, 1 written, 8 tool calls',
        dispatchedAt: Date.now() - 1500,
        fallback: '[1/1] Review (claude)',
      },
    }));
    snap = registry.get(batchId)!.perTaskHeadlineSnapshots!.get(0)!;
    expect(snap.stageLabel).toBe('Review');
    expect(snap.stageDone).toBe(2);

    // Annotating tick
    recordHeartbeat(baseTick({
      stage: 'annotating',
      stageIndex: 3,
      progress: { filesRead: 3, filesWritten: 1, toolCalls: 9 },
      snapshot: {
        prefix: '[1/1] Annotating (claude) — ',
        statsClause: ', 3 read, 1 written, 9 tool calls',
        dispatchedAt: Date.now() - 2000,
        fallback: '[1/1] Annotating (claude)',
      },
    }));
    snap = registry.get(batchId)!.perTaskHeadlineSnapshots!.get(0)!;
    expect(snap.stageLabel).toBe('Annotating');
    expect(snap.stageDone).toBe(3);
    expect(snap.toolTotal).toBe(9);
  });
});
