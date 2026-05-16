import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndRegistry, bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { BatchRegistry } from '../../packages/core/src/stores/batch-registry.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import { makeRetrySlot } from '../../packages/core/src/intake/brief-compiler-slots/retry.js';
import type { RetryInput } from '../../packages/core/src/intake/brief-compiler-slots/retry.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeRetryParseBrief(registry: BatchRegistry): StageHandler {
  const slot = makeRetrySlot(registry);
  return (state: LifecycleState): void => {
    const req = state.request as RetryInput | undefined;
    if (!req || !Array.isArray(req.retryableFor) || req.retryableFor.length === 0) {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    const briefs = slot(req);
    (state as any).retryBriefs = briefs;
    state.userMessage = briefs[0].brief;
    (state as any).reviewPolicy = briefs[0].reviewPolicy;
    (state as any).cwd = briefs[0].cwd;
    (state as any).contextBlockIds = briefs[0].contextBlockIds;
  };
}

function makeRetryComposeResponse(): StageHandler {
  return (state: LifecycleState): void => {
    const lastResult = state.lastRunResult as { finalAssistantText?: string; workerStatus?: string; errorCode?: string } | undefined;
    const workerOutput = lastResult?.finalAssistantText ?? '';

    let structuredReport: unknown = null;
    const m = workerOutput.match(/```json\n([\s\S]+?)\n```/);
    if (m) {
      try { structuredReport = JSON.parse(m[1]); } catch { /* leave null */ }
    }

    (state as any).responseEnvelope = [{
      terminalStatus: state.terminalStatus ?? (lastResult?.errorCode ? 'error' : 'ok'),
      structuredReport,
      workerStatus: lastResult?.workerStatus,
      errorCode: lastResult?.errorCode,
    }];
  };
}

describe('retry_tasks via v4.0 lifecycle', () => {
  // Deleted: this test exercised the legacy `bootstrapWithMockAdapterAndRegistry` +
  // `overrideHandler('compose_response', ...)` pattern that no longer exists in
  // the v5 dispatcher. The retry route's end-to-end behavior is covered by the
  // HTTP contract test at tests/contract/http/retry-tasks.test.ts which exercises
  // the same flow via the real production path.

  it('preserves original taskIndex and inheritedToolCategory in briefs', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b2',
      projectCwd: '/tmp',
      tool: 'delegate',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'artifact_producing',
      tasks: [
        { brief: 'task 0', cwd: '/tmp', agentType: 'standard', reviewPolicy: 'full', contextBlockIds: [] },
        { brief: 'task 1', cwd: '/tmp', agentType: 'complex', reviewPolicy: 'none', contextBlockIds: ['cb-1'] },
      ],
    });

    const slot = makeRetrySlot(registry);
    const briefs = slot({ batchId: 'b2', retryableFor: [1, 0] });

    expect(briefs).toHaveLength(2);
    // First output task (index 0) maps to original task 1
    expect(briefs[0].taskIndex).toBe(0);
    expect(briefs[0].originalTaskIndex).toBe(1);
    expect(briefs[0].brief).toBe('task 1');
    expect(briefs[0].agentType).toBe('complex');
    expect(briefs[0].reviewPolicy).toBe('none');
    expect(briefs[0].contextBlockIds).toEqual(['cb-1']);
    expect(briefs[0].inheritedToolCategory).toBe('artifact_producing');
    // Second output task (index 1) maps to original task 0
    expect(briefs[1].taskIndex).toBe(1);
    expect(briefs[1].originalTaskIndex).toBe(0);
    expect(briefs[1].brief).toBe('task 0');
    expect(briefs[1].inheritedToolCategory).toBe('artifact_producing');
  });

  it('appends prior terminal block to contextBlockIds', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b3',
      projectCwd: '/tmp',
      tool: 'delegate',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'artifact_producing',
      tasks: [
        { brief: 'task with prior context', cwd: '/tmp', agentType: 'standard', reviewPolicy: 'full', contextBlockIds: ['existing-cb'] },
      ],
    });
    registry.recordTerminalBlock('b3', 0, 'terminal-b3-0');

    const slot = makeRetrySlot(registry);
    const briefs = slot({ batchId: 'b3', retryableFor: [0] });

    expect(briefs[0].contextBlockIds).toEqual(['existing-cb', 'terminal-b3-0']);
  });

  it('inherits toolCategory from original batch (delegate → artifact_producing)', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b4',
      projectCwd: '/tmp',
      tool: 'delegate',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'artifact_producing',
      tasks: [
        { brief: 'x', cwd: '/tmp', agentType: 'standard', reviewPolicy: 'full', contextBlockIds: [] },
      ],
    });

    const slot = makeRetrySlot(registry);
    const briefs = slot({ batchId: 'b4', retryableFor: [0] });
    expect(briefs[0].inheritedToolCategory).toBe('artifact_producing');
  });

  it('inherits toolCategory from original batch (audit → read_only)', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b5',
      projectCwd: '/tmp',
      tool: 'audit',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'read_only',
      tasks: [
        { brief: 'audit task', cwd: '/tmp', agentType: 'standard', reviewPolicy: 'none', contextBlockIds: [] },
      ],
    });

    const slot = makeRetrySlot(registry);
    const briefs = slot({ batchId: 'b5', retryableFor: [0] });
    expect(briefs[0].inheritedToolCategory).toBe('read_only');
  });

  it('inherits toolCategory from original batch (explore → research)', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b6',
      projectCwd: '/tmp',
      tool: 'explore',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'research',
      tasks: [
        { brief: 'explore task', cwd: '/tmp', agentType: 'complex', reviewPolicy: 'none', contextBlockIds: [] },
      ],
    });

    const slot = makeRetrySlot(registry);
    const briefs = slot({ batchId: 'b6', retryableFor: [0] });
    expect(briefs[0].inheritedToolCategory).toBe('research');
  });

  it('throws for unknown batchId', () => {
    const registry = new BatchRegistry();
    const slot = makeRetrySlot(registry);
    expect(() => slot({ batchId: 'nonexistent', retryableFor: [0] })).toThrow('unknown batchId');
  });

  it('throws when original batch has missing toolCategory', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b7',
      projectCwd: '/tmp',
      tool: 'delegate',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      // toolCategory intentionally missing
    });

    const slot = makeRetrySlot(registry);
    expect(() => slot({ batchId: 'b7', retryableFor: [0] })).toThrow('missing or invalid toolCategory');
  });

  it('throws when original toolCategory is assist', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b8',
      projectCwd: '/tmp',
      tool: 'retry',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'assist' as any,
    });

    const slot = makeRetrySlot(registry);
    expect(() => slot({ batchId: 'b8', retryableFor: [0] })).toThrow('assist is route-level only');
  });

  it('throws when task index is out of range', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b9',
      projectCwd: '/tmp',
      tool: 'delegate',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'artifact_producing',
      tasks: [
        { brief: 'only one task', cwd: '/tmp', agentType: 'standard', reviewPolicy: 'full', contextBlockIds: [] },
      ],
    });

    const slot = makeRetrySlot(registry);
    expect(() => slot({ batchId: 'b9', retryableFor: [5] })).toThrow('out of range');
  });

  it('overrides cwd from RetryInput when provided', () => {
    const registry = new BatchRegistry();
    registry.register({
      batchId: 'b10',
      projectCwd: '/original',
      tool: 'delegate',
      state: 'complete',
      startedAt: Date.now() - 60_000,
      stateChangedAt: Date.now(),
      blockIds: [],
      blocksReleased: false,
      toolCategory: 'artifact_producing',
      tasks: [
        { brief: 'x', cwd: '/original', agentType: 'standard', reviewPolicy: 'full', contextBlockIds: [] },
      ],
    });

    const slot = makeRetrySlot(registry);
    const briefs = slot({ batchId: 'b10', retryableFor: [0], cwd: '/overridden' });
    expect(briefs[0].cwd).toBe('/overridden');
  });
});
