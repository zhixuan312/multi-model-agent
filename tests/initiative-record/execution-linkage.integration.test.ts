import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });
const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'ignored', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: 'ignored', source: 'test' };
async function mutate(h: { baseUrl: string; token: string }, operation: string, input: object, expected_revision: number) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation, input, expected_revision, provenance }) });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}
async function terminal(h: { baseUrl: string; token: string }, executionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${h.baseUrl}/execution/${executionId}`, { headers: headers(h.token) });
    if (response.status === 200) return await response.json() as Record<string, unknown>;
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('mock execution did not become terminal');
}

describe('Execution linkage integration', () => {
  it('records linked mock-provider work and replays an unconsumed outbox row after reopen', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd(), failLinkerOnceAfterTerminal: true });
    try {
      const product = await mutate(h, 'product_create', { name: 'MMA', slug: 'mma-linkage' }, 0);
      const initiative = await mutate(h, 'initiative_create', { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, 0);
      const task = await mutate(h, 'initiative_task_create', { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, 0);
      await mutate(h, 'initiative_task_claim', { uuid: task.uuid }, 0);
      const conflicted = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-b' } }) });
      expect(conflicted.status).toBe(400);
      expect(await conflicted.json()).toMatchObject({ error: { code: 'task_claim_conflict' } });
      expect(h.unconsumedOutbox()).toEqual([]);
      const dispatch = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-a' } }) });
      expect(dispatch.status).toBe(202);
      const { executionId } = await dispatch.json() as { executionId: string };
      await terminal(h, executionId);
      expect(h.unconsumedOutbox()).toHaveLength(1);
      const restarted = await h.restart();
      try {
        const resume = await fetch(`${restarted.baseUrl}/initiatives`, { method: 'POST', headers: headers(restarted.token), body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative.uuid } }) });
        const record = await resume.json() as { tasks: Array<{ status: string; outcome: string | null; executionRefs: string[] }>; evidence: unknown[] };
        expect(record.tasks).toEqual([expect.objectContaining({ status: 'completed', outcome: 'succeeded_with_concerns', executionRefs: [executionId] })]);
        expect(record.evidence).toHaveLength(1);
        expect(restarted.unconsumedOutbox()).toEqual([]);
        const invalid = await fetch(`${restarted.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(restarted.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-a' } }) });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_task_transition' } });
        expect(restarted.unconsumedOutbox()).toEqual([]);
      } finally { await restarted.close(); }
    } finally { await h.close(); }
  });
});