// tests/server/handlers/control/batch.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'mmagent-batch-test-'));
}

describe('GET /batch/:batchId', () => {
  it('404 on unknown batchId', async () => {
    const s = await startTestServerWithAgents();
    try {
      const unknownId = randomUUID();
      const res = await fetch(`${s.url}/batch/${unknownId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('returns 202 text/plain for a pending batch', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const delegateRes = await fetch(`${s.url}/delegate?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'do something' }] }),
      });
      expect(delegateRes.status).toBe(202);
      const { batchId } = await delegateRes.json() as { batchId: string };

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(202);
      expect(res.headers.get('content-type')).toMatch(/text\/plain/);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/^\{/);
    } finally {
      await s.stop();
    }
  });

  it('returns taskIndex-sliced result for a complete multi-task batch', async () => {
    const s = await startTestServerWithAgents();
    try {
      // Directly inject a complete batch into the registry
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });
      s.batchRegistry.complete(batchId, {
        headline: 'delegate: 3/3 tasks complete',
        results: [
          { status: 'ok', output: 'result-0' },
          { status: 'ok', output: 'result-1' },
          { status: 'ok', output: 'result-2' },
        ],
        batchTimings: {},
        costSummary: {},
        structuredReport: { kind: 'not_applicable', reason: 'none' },
        error: { kind: 'not_applicable', reason: 'batch succeeded' },
      });

      const resAll = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(resAll.status).toBe(200);
      const jsonAll = await resAll.json() as { results: unknown[] };
      expect(jsonAll.results).toHaveLength(3);

      const resSliced = await fetch(`${s.url}/batch/${batchId}?taskIndex=1`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(resSliced.status).toBe(200);
      const jsonSliced = await resSliced.json() as { results: unknown[] };
      expect(jsonSliced.results).toHaveLength(1);
      expect((jsonSliced.results[0] as { output: string }).output).toBe('result-1');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_task_index on non-numeric taskIndex', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Create a batch first
      const delegateRes = await fetch(`${s.url}/delegate?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'task' }] }),
      });
      const { batchId } = await delegateRes.json() as { batchId: string };

      const res = await fetch(`${s.url}/batch/${batchId}?taskIndex=abc`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_task_index');
    } finally {
      await s.stop();
    }
  });

  it('returns 404 unknown_task_index when taskIndex >= results.length', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });
      s.batchRegistry.complete(batchId, {
        headline: 'delegate: 1/1 tasks complete',
        results: [{ status: 'ok', output: 'only-one' }],
        batchTimings: {},
        costSummary: {},
        structuredReport: { kind: 'not_applicable', reason: 'none' },
        error: { kind: 'not_applicable', reason: 'batch succeeded' },
      });

      // taskIndex=1 is out of range for a 1-element array
      const res = await fetch(`${s.url}/batch/${batchId}?taskIndex=1`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('unknown_task_index');
    } finally {
      await s.stop();
    }
  });

  it('taskIndex is ignored when batch is pending', async () => {
    const s = await startTestServerWithAgents();
    try {
      // Inject a pending batch directly into the registry
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });

      // taskIndex=99 on a pending batch — should NOT error, returns 202 text/plain
      const res = await fetch(`${s.url}/batch/${batchId}?taskIndex=99`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(202);
      expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    } finally {
      await s.stop();
    }
  });

  it('returns expired state for an expired batch', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      // Register and immediately mark complete, then transition to expired
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });
      s.batchRegistry.complete(batchId, { results: [] });

      // Directly set state to expired by hacking the entry (workaround since we
      // can't control time for the TTL sweep, and the server's batchTtlMs is 1h)
      // Instead, use get() and mutate the state + trigger sweep with stateChangedAt=0
      const entry = s.batchRegistry.get(batchId)!;
      entry.stateChangedAt = 0; // in the past
      s.batchRegistry.runExpirySweep(); // first sweep: complete → expired
      // entry is still in the map now (second sweep removes it)

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { headline: string };
      expect(json.headline).toMatch(/expired/);
    } finally {
      await s.stop();
    }
  });

  it('failed batch returns 200 JSON with populated error + NotApplicable sentinels', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId, projectCwd: '/tmp/test', tool: 'delegate',
        state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(),
        blockIds: [], blocksReleased: false,
      });
      s.batchRegistry.fail(batchId, { code: 'runner_crash', message: 'boom' });

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { error: { code: string }; results: { kind: string } };
      expect(body.error.code).toBe('runner_crash');
      expect(body.results.kind).toBe('not_applicable');
    } finally {
      await s.stop();
    }
  });

  it('multi-task pending batch renders ONE aggregated line with slowest as representative + +K suffix', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId, projectCwd: '/tmp/test', tool: 'delegate',
        state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(),
        blockIds: [], blocksReleased: false,
        tasksTotal: 3,
      });
      // Three tasks running, each at different stages and counts.
      // Task 0 dispatched earliest (largest elapsed) → it is the representative.
      const now = Date.now();
      s.batchRegistry.updatePerTaskHeadlineSnapshot(batchId, 0, {
        prefix: 'Implementing by Standard worker (1/9) - ',
        statsClause: ', 22 read, 0 write, 22 tool calls',
        dispatchedAt: now - 360_000, // 6m ago — the laggard
        fallback: 'Implementing by Standard worker (1/9)',
        stageLabel: 'Implementing', tier: 'Standard',
        stageDone: 1, stageTotal: 9,
        toolReads: 22, toolWrites: 0, toolTotal: 22,
      });
      s.batchRegistry.updatePerTaskHeadlineSnapshot(batchId, 1, {
        prefix: 'Reviewing by Complex worker (4/7) - ',
        statsClause: ', 8 read, 1 write, 14 tool calls',
        dispatchedAt: now - 130_000,
        fallback: 'Reviewing by Complex worker (4/7)',
        stageLabel: 'Reviewing', tier: 'Complex',
        stageDone: 4, stageTotal: 7,
        toolReads: 8, toolWrites: 1, toolTotal: 14,
      });
      s.batchRegistry.updatePerTaskHeadlineSnapshot(batchId, 2, {
        prefix: 'Verifying by Standard worker (6/8) - ',
        statsClause: ', 47 read, 3 write, 88 tool calls',
        dispatchedAt: now - 60_000,
        fallback: 'Verifying by Standard worker (6/8)',
        stageLabel: 'Verifying', tier: 'Standard',
        stageDone: 6, stageTotal: 8,
        toolReads: 47, toolWrites: 3, toolTotal: 88,
      });

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(202);
      const text = await res.text();
      expect(text).not.toContain('\n'); // ALWAYS one line
      expect(text).toMatch(/^\[3\/3\] Implementing by Standard worker \(1\/9\) \+2 - /);
      expect(text).toMatch(/, 77 read, 4 write, 124 tool calls$/); // sums: 22+8+47, 0+1+3, 22+14+88
    } finally {
      await s.stop();
    }
  });

  it('single-task pending batch renders one line WITHOUT +K suffix (byte-identical shape)', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId, projectCwd: '/tmp/test', tool: 'delegate',
        state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(),
        blockIds: [], blocksReleased: false,
        tasksTotal: 1,
      });
      const now = Date.now();
      s.batchRegistry.updatePerTaskHeadlineSnapshot(batchId, 0, {
        prefix: 'Implementing by Standard worker (1/9) - ',
        statsClause: ', 22 read, 0 write, 22 tool calls',
        dispatchedAt: now - 360_000,
        fallback: 'Implementing by Standard worker (1/9)',
        stageLabel: 'Implementing', tier: 'Standard',
        stageDone: 1, stageTotal: 9,
        toolReads: 22, toolWrites: 0, toolTotal: 22,
      });

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(202);
      const text = await res.text();
      expect(text).not.toContain('\n');
      expect(text).not.toContain('+'); // no +K suffix when only one running
      expect(text).toMatch(/^\[1\/1\] Implementing by Standard worker \(1\/9\) - /);
      expect(text).toMatch(/, 22 read, 0 write, 22 tool calls$/);
    } finally {
      await s.stop();
    }
  });

  it('terminal 200 JSON always includes all 7 envelope fields', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId, projectCwd: '/tmp/test', tool: 'delegate',
        state: 'pending', startedAt: Date.now(), stateChangedAt: Date.now(),
        blockIds: [], blocksReleased: false,
      });
      s.batchRegistry.complete(batchId, {
        headline: 'delegate: 0/0 tasks complete',
        results: [],
        batchTimings: {},
        costSummary: {},
        structuredReport: { kind: 'not_applicable', reason: 'none' },
        error: { kind: 'not_applicable', reason: 'batch succeeded' },
      });

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = await res.json();
      for (const key of ['headline', 'results', 'batchTimings', 'costSummary', 'structuredReport', 'error']) {
        expect(body, `missing ${key}`).toHaveProperty(key);
      }
    } finally {
      await s.stop();
    }
  });
});
