import { describe, it, expect } from 'vitest';
import { BatchRegistry } from '../../../packages/core/src/stores/batch-registry.js';
import { buildBatchHandler } from '../../../packages/server/src/http/handlers/control/batch.js';

function makeSnap(dispatchedAt: number) {
  return { prefix: '[task] running - ', statsClause: '', dispatchedAt, fallback: 'task running' };
}

function mockRes() {
  const chunks: string[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  return {
    chunks, getStatus: () => status, getHeaders: () => headers,
    res: {
      writeHead(s: number, h: Record<string, string>) { status = s; headers = h; },
      end(body?: string) { if (body) chunks.push(body); },
      setHeader() {},
    } as any,
  };
}

function mockCtx(url: string) {
  return {
    url: new URL(`http://localhost${url}`),
  };
}

describe('batch GET pending headline — grouped dispatch', () => {
  it('appends (sequential) for a single-group batch', async () => {
    const registry = new BatchRegistry();
    const batchId = 'test-1';
    registry.register({
      batchId, projectCwd: '/repo', tool: 'delegate', state: 'pending',
      startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false,
      tasksTotal: 3, runningHeadlineSnapshot: makeSnap(Date.now()),
    });
    registry.attachGroups(batchId, [{ key: '/repo', taskIndices: [0, 1, 2] }]);
    // Simulate task 1 in flight.
    registry.updatePerTaskHeadlineSnapshot(batchId, 1, makeSnap(Date.now()));

    const handler = buildBatchHandler({ batchRegistry: registry } as any);
    const { res, chunks, getStatus } = mockRes();
    await handler({} as any, res, { batchId }, mockCtx(`/batch/${batchId}`));
    expect(getStatus()).toBe(202);
    expect(chunks.join('')).toContain('(sequential)');
    expect(chunks.join('')).not.toMatch(/ \+\d+/);
  });

  it('appends (group X/Y, sequential) for a multi-group batch', async () => {
    const registry = new BatchRegistry();
    const batchId = 'test-2';
    const now = Date.now();
    registry.register({
      batchId, projectCwd: '/repo', tool: 'delegate', state: 'pending',
      startedAt: now, stateChangedAt: now, blockIds: [], blocksReleased: false,
      tasksTotal: 4, runningHeadlineSnapshot: makeSnap(now),
    });
    registry.attachGroups(batchId, [
      { key: '/repoA', taskIndices: [0, 1] },
      { key: '/repoB', taskIndices: [2, 3] },
    ]);
    registry.updatePerTaskHeadlineSnapshot(batchId, 0, makeSnap(now));      // group A leader
    registry.updatePerTaskHeadlineSnapshot(batchId, 2, makeSnap(now + 10)); // group B in flight

    const handler = buildBatchHandler({ batchRegistry: registry } as any);
    const { res, chunks, getStatus } = mockRes();
    await handler({} as any, res, { batchId }, mockCtx(`/batch/${batchId}`));
    expect(getStatus()).toBe(202);
    const body = chunks.join('');
    expect(body).toContain('(group 1/2, sequential)');
    expect(body).toContain(' +1'); // one in-flight task in the other group
  });

  it('keeps headline unchanged when groups are absent (read-only route)', async () => {
    const registry = new BatchRegistry();
    const batchId = 'test-3';
    registry.register({
      batchId, projectCwd: '/repo', tool: 'audit', state: 'pending',
      startedAt: Date.now(), stateChangedAt: Date.now(), blockIds: [], blocksReleased: false,
      tasksTotal: 3, runningHeadlineSnapshot: makeSnap(Date.now()),
    });
    // No attachGroups call.

    const handler = buildBatchHandler({ batchRegistry: registry } as any);
    const { res, chunks, getStatus } = mockRes();
    await handler({} as any, res, { batchId }, mockCtx(`/batch/${batchId}`));
    expect(getStatus()).toBe(202);
    expect(chunks.join('')).not.toContain('sequential');
  });
});
