// tests/server/async-dispatch.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchRegistry, createProjectContext } from '@zhixuan92/multi-model-agent-core';
import { asyncDispatch } from '../../packages/server/src/http/async-dispatch.js';
import type { HandlerDeps } from '../../packages/server/src/http/handler-deps.js';

// Minimal stub HandlerDeps — execution-context is never reached in these tests
// because we replace executor behavior entirely.
function makeStubDeps(batchRegistry: BatchRegistry): HandlerDeps {
  const logger = {
    startup: vi.fn(),
    requestStart: vi.fn(),
    requestComplete: vi.fn(),
    error: vi.fn(),
    shutdown: vi.fn(),
    expectedPath: vi.fn(),
    sessionOpen: vi.fn(),
    sessionClose: vi.fn(),
    connectionRejected: vi.fn(),
    requestRejected: vi.fn(),
    projectCreated: vi.fn(),
    projectEvicted: vi.fn(),
    taskStarted: vi.fn(), emit: vi.fn(),
    emit: vi.fn(),
    batchCompleted: vi.fn(),
    batchFailed: vi.fn(),
  } satisfies HandlerDeps['logger'];
  return {
    config: {} as HandlerDeps['config'],
    logger,
    bus: { emit: vi.fn() } as HandlerDeps['bus'],
    projectRegistry: {} as HandlerDeps['projectRegistry'],
    batchRegistry,
  };
}

describe('asyncDispatch', () => {
  const cwd = '/tmp/test-project';

  it('registers batch as pending and returns batchId + statusUrl immediately', () => {
    const batchRegistry = new BatchRegistry();
    const pc = createProjectContext(cwd);
    const deps = makeStubDeps(batchRegistry);

    const neverResolving = new Promise<string>(() => {}); // never resolves
    const result = asyncDispatch({
      tool: 'delegate',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry,
      projectContext: pc,
      deps,
      executor: () => neverResolving,
    });

    expect(result.batchId).toBeTypeOf('string');
    expect(result.statusUrl).toBe(`/batch/${result.batchId}`);

    const entry = batchRegistry.get(result.batchId);
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('pending');
    expect(entry!.tool).toBe('delegate');
    expect(entry!.projectCwd).toBe(cwd);
  });

  it('transitions batch to complete when executor resolves', async () => {
    const batchRegistry = new BatchRegistry();
    const pc = createProjectContext(cwd);
    const deps = makeStubDeps(batchRegistry);

    const syntheticResult = { ok: true, value: 42 };

    const result = asyncDispatch({
      tool: 'delegate',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry,
      projectContext: pc,
      deps,
      executor: async () => syntheticResult,
    });

    // Wait for setImmediate + executor to complete
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entry = batchRegistry.get(result.batchId);
    expect(entry!.state).toBe('complete');
    expect(entry!.result).toEqual(syntheticResult);
  });

  it('transitions batch to failed when executor throws', async () => {
    const batchRegistry = new BatchRegistry();
    const pc = createProjectContext(cwd);
    const deps = makeStubDeps(batchRegistry);

    const result = asyncDispatch({
      tool: 'audit',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry,
      projectContext: pc,
      deps,
      executor: async () => { throw new Error('something went wrong'); },
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entry = batchRegistry.get(result.batchId);
    expect(entry!.state).toBe('failed');
    expect(entry!.error?.code).toBe('runner_crash');
    expect(entry!.error?.message).toBe('something went wrong');
  });

  it('bumps runningHeadlineSnapshot to "1/1 running" when the executor begins (4.0.2 fix)', async () => {
    // Regression for the v4.0.1 "0/1 queued forever" UX: even though
    // tasksStarted=1 was set when the executor body fired, the polling
    // endpoint's `entry.runningHeadlineSnapshot.fallback` stayed at
    // "0/1 queued" until the runner emitted its first heartbeat. When
    // the LLM provider call hung, no heartbeat ever came and users saw
    // no progress indication — making it look like the daemon itself
    // was deadlocked. async-dispatch now updates the snapshot directly
    // so the polling endpoint reports running state immediately.
    const batchRegistry = new BatchRegistry();
    const pc = createProjectContext(cwd);
    const deps = makeStubDeps(batchRegistry);

    let resolveExecutor: (v: unknown) => void = () => {};
    const slowExecutor = new Promise((r) => { resolveExecutor = r; });

    const result = asyncDispatch({
      tool: 'audit',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry,
      projectContext: pc,
      deps,
      executor: () => slowExecutor,
    });

    // Drain setImmediate so the executor body runs (sets tasksStarted=1
    // and bumps the snapshot) but does NOT yet resolve.
    await new Promise<void>((r) => setImmediate(r));

    const entry = batchRegistry.get(result.batchId);
    expect(entry!.state).toBe('pending'); // executor still in flight
    expect(entry!.tasksStarted).toBe(1);
    expect(entry!.runningHeadlineSnapshot.prefix).toBe('1/1 running, ');
    expect(entry!.runningHeadlineSnapshot.fallback).toBe('1/1 running');

    // Cleanup so vitest doesn't hang on the unresolved promise.
    resolveExecutor({});
    await new Promise<void>((r) => setImmediate(r));
  });

  it('registers blockIds on the batch entry', () => {
    const batchRegistry = new BatchRegistry();
    const pc = createProjectContext(cwd);
    const deps = makeStubDeps(batchRegistry);

    const blockIds = ['block-1', 'block-2'];
    const result = asyncDispatch({
      tool: 'review',
      projectCwd: cwd,
      blockIds,
      batchRegistry,
      projectContext: pc,
      deps,
      executor: async () => ({}),
    });

    const entry = batchRegistry.get(result.batchId);
    expect(entry!.blockIds).toEqual(blockIds);
  });

  it('does not use activeBatches counter — countActiveForProject reflects live state', async () => {
    const batchRegistry = new BatchRegistry();
    const pc = createProjectContext(cwd);
    const deps = makeStubDeps(batchRegistry);

    // Before dispatch: 0 active
    expect(batchRegistry.countActiveForProject(cwd)).toBe(0);

    const result = asyncDispatch({
      tool: 'delegate',
      projectCwd: cwd,
      blockIds: [],
      batchRegistry,
      projectContext: pc,
      deps,
      executor: async () => 'done',
    });

    // After dispatch but before executor completes: 1 active (pending)
    expect(batchRegistry.countActiveForProject(cwd)).toBe(1);

    // After executor completes: 0 active (complete is terminal)
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const entry = batchRegistry.get(result.batchId);
    expect(entry!.state).toBe('complete');
    expect(batchRegistry.countActiveForProject(cwd)).toBe(0);
  });
});
