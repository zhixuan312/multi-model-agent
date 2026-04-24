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
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('returns pending state for a newly dispatched batch', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // POST /delegate creates a batch that stays pending (fake agents don't respond)
      const delegateRes = await fetch(`${s.url}/delegate?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'do something' }] }),
      });
      expect(delegateRes.status).toBe(202);
      const { batchId } = await delegateRes.json() as { batchId: string };

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { state: string; startedAt: number };
      expect(json.state).toBe('pending');
      expect(typeof json.startedAt).toBe('number');
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
        status: 'ok',
        results: [
          { status: 'ok', output: 'result-0' },
          { status: 'ok', output: 'result-1' },
          { status: 'ok', output: 'result-2' },
        ],
      });

      // Without taskIndex — all results
      const resAll = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(resAll.status).toBe(200);
      const jsonAll = await resAll.json() as { state: string; result: { results: unknown[] } };
      expect(jsonAll.state).toBe('complete');
      expect(jsonAll.result.results).toHaveLength(3);

      // With taskIndex=1 — only second result
      const resSliced = await fetch(`${s.url}/batch/${batchId}?taskIndex=1`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(resSliced.status).toBe(200);
      const jsonSliced = await resSliced.json() as { state: string; result: { results: unknown[] } };
      expect(jsonSliced.state).toBe('complete');
      expect(jsonSliced.result.results).toHaveLength(1);
      expect((jsonSliced.result.results[0] as { output: string }).output).toBe('result-1');
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
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tasks: [{ prompt: 'task' }] }),
      });
      const { batchId } = await delegateRes.json() as { batchId: string };

      const res = await fetch(`${s.url}/batch/${batchId}?taskIndex=abc`, {
        headers: { Authorization: `Bearer ${s.token}` },
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
        status: 'ok',
        results: [{ status: 'ok', output: 'only-one' }],
      });

      // taskIndex=1 is out of range for a 1-element array
      const res = await fetch(`${s.url}/batch/${batchId}?taskIndex=1`, {
        headers: { Authorization: `Bearer ${s.token}` },
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

      // taskIndex=99 on a pending batch — should NOT error, just return pending
      const res = await fetch(`${s.url}/batch/${batchId}?taskIndex=99`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { state: string };
      expect(json.state).toBe('pending');
    } finally {
      await s.stop();
    }
  });

  it('returns awaiting_clarification state with proposedInterpretation', async () => {
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
      s.batchRegistry.requestClarification(batchId, 'Did you mean X or Y?');

      const res = await fetch(`${s.url}/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { state: string; proposedInterpretation: string };
      expect(json.state).toBe('awaiting_clarification');
      expect(json.proposedInterpretation).toBe('Did you mean X or Y?');
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
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { state: string };
      expect(json.state).toBe('expired');
    } finally {
      await s.stop();
    }
  });
});
