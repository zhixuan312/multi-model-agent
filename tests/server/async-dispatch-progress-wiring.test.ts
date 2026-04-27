/**
 * Regression guard for 3.1.2: asyncDispatch must update the BatchEntry's
 * tasksStarted counter so composeRunningHeadline transitions from "1/1 queued"
 * to "1/1 running, Xs elapsed". Before this fix, the counters were added to
 * BatchEntry but nothing ever wrote them — pending batches polled as "queued"
 * for their entire run.
 */
import { describe, it, expect, vi } from 'vitest';
import { BatchRegistry, createProjectContext } from '@zhixuan92/multi-model-agent-core';
import { asyncDispatch } from '../../packages/server/src/http/async-dispatch.js';
import type { HandlerDeps } from '../../packages/server/src/http/handler-deps.js';

function stubDeps(batchRegistry: BatchRegistry): HandlerDeps {
  const logger = {
    startup: vi.fn(), requestStart: vi.fn(), requestComplete: vi.fn(),
    error: vi.fn(), shutdown: vi.fn(), expectedPath: vi.fn(),
    sessionOpen: vi.fn(), sessionClose: vi.fn(),
    connectionRejected: vi.fn(), requestRejected: vi.fn(),
    projectCreated: vi.fn(), projectEvicted: vi.fn(),
    taskStarted: vi.fn(), emit: vi.fn(),
    batchCompleted: vi.fn(), batchFailed: vi.fn(),
  } satisfies HandlerDeps['logger'];
  return {
    config: {} as HandlerDeps['config'],
    logger,
    bus: { emit: vi.fn() } as HandlerDeps['bus'],
    projectRegistry: {} as HandlerDeps['projectRegistry'],
    batchRegistry,
  };
}

describe('asyncDispatch progress wiring (3.1.2 regression guard)', () => {
  it('sets tasksStarted=1 before executor runs so headline leaves "queued"', async () => {
    const reg = new BatchRegistry();
    const deps = stubDeps(reg);
    const pc = createProjectContext({
      cwd: '/tmp/test',
      contextBlockTtlMs: 60_000,
      maxContextBlocksPerProject: 10,
    });

    // Resolve when the executor has been invoked but BEFORE it returns,
    // so we can inspect the BatchEntry mid-flight.
    let batchIdSeen: string | undefined;
    const executorGate = new Promise<void>((resolveGate) => {
      asyncDispatch({
        tool: 'delegate',
        projectCwd: '/tmp/test',
        blockIds: [],
        batchRegistry: reg,
        projectContext: pc,
        deps,
        executor: async (_ctx, batchId) => {
          batchIdSeen = batchId;
          // Signal the test to inspect now.
          resolveGate();
          // Stall so the test can observe mid-flight state before completion.
          await new Promise((r) => setTimeout(r, 50));
          return { headline: 'done', results: [] };
        },
      });
    });

    await executorGate;
    expect(batchIdSeen).toBeDefined();
    const midFlight = reg.get(batchIdSeen!);
    expect(midFlight?.tasksTotal).toBe(1);
    expect(midFlight?.tasksStarted).toBe(1);
    expect(midFlight?.tasksCompleted).toBe(0);

    // Wait for the executor to finish and the batch to complete.
    await new Promise((r) => setTimeout(r, 120));
    const terminal = reg.get(batchIdSeen!);
    expect(terminal?.state).toBe('complete');
    // release() clears progress counters on terminal transitions.
    expect(terminal?.tasksStarted).toBeUndefined();
  });
});
