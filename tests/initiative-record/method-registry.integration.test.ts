import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });
const provenance = { actor_type: 'agent', actor_id: 'a', interface: 'ignored', initiated_by: 'a', authorized_by: 'a', timestamp: 'ignored', source: 'test' };
async function post(h: { baseUrl: string; token: string }, url: string, body: object) { const r = await fetch(`${h.baseUrl}${url}`, { method: 'POST', headers: headers(h.token), body: JSON.stringify(body) }); return { r, body: await r.json() as Record<string, any> }; }
async function waitForTerminal(h: { baseUrl: string; token: string }, executionId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const poll = await fetch(`${h.baseUrl}/execution/${executionId}`, { headers: headers(h.token) });
    if (poll.status === 200) return;
    expect(poll.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`execution ${executionId} did not reach a terminal state`);
}

describe('Method Registry HTTP integration', () => {
  it('inherits, overrides, clears, records durably, and injects the effective Method', async () => {
    const prompts: string[] = [];
    let h = await boot({ provider: mockProvider({ stage: 'ok', onPrompt: (prompt) => prompts.push(prompt) }), cwd: process.cwd() });
    try {
      const product = (await post(h, '/initiatives', { operation: 'product_create', input: { name: 'MMA', slug: 'method-http' }, expected_revision: 0, provenance })).body;
      const initiative = (await post(h, '/initiatives', { operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance })).body;
      const inheritedTask = (await post(h, '/initiatives', { operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'Inherited', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [], method: 'software-change@1' }, expected_revision: 0, provenance })).body;
      const overrideTask = (await post(h, '/initiatives', { operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'Override', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [], method: 'software-change@1' }, expected_revision: 0, provenance })).body;
      const clearedTask = (await post(h, '/initiatives', { operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'Cleared', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [], method: 'software-change@1' }, expected_revision: 0, provenance })).body;

      // (1) Inherited: no request method, Task declares software-change@1.
      const inherited = await post(h, `/execution?cwd=${encodeURIComponent(process.cwd())}`, { type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: inheritedTask.uuid, authorized_by: 'a' } });
      expect(inherited.r.status).toBe(202);
      await waitForTerminal(h, inherited.body.executionId);

      // (2) Explicit request method OVERRIDES the linked Task's declared method (precedence).
      const overridden = await post(h, `/execution?cwd=${encodeURIComponent(process.cwd())}`, { type: 'review', target: { paths: ['/tmp/b.ts'] }, method: 'research@1', initiative: { initiative: { uuid: initiative.uuid }, task_uuid: overrideTask.uuid, authorized_by: 'a' } });
      expect(overridden.r.status).toBe(202);
      await waitForTerminal(h, overridden.body.executionId);

      const clear = await post(h, '/initiatives', { operation: 'initiative_task_set_method', input: { initiative: { uuid: initiative.uuid }, task: { uuid: clearedTask.uuid }, method: null }, expected_revision: clearedTask.revision, provenance });
      expect(clear.r.status).toBe(200);

      // (3) No request method, submitted AFTER the Task's method is cleared: effective method is
      // null and no guidance block is injected.
      const cleared = await post(h, `/execution?cwd=${encodeURIComponent(process.cwd())}`, { type: 'review', target: { paths: ['/tmp/c.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: clearedTask.uuid, authorized_by: 'a' } });
      expect(cleared.r.status).toBe(202);
      await waitForTerminal(h, cleared.body.executionId);

      const executionsBeforeBad = h.executionRowCount();
      const bad = await post(h, `/execution?cwd=${encodeURIComponent(process.cwd())}`, { type: 'review', target: { paths: ['/tmp/a.ts'] }, method: 'missing@1' });
      expect(bad.r.status).toBe(400);
      expect(bad.body).toMatchObject({ error: { code: 'unknown_method' } });
      expect(h.executionRowCount()).toBe(executionsBeforeBad);

      expect(prompts).toHaveLength(6);
      expect(prompts[0]!.match(/Caller tracing/g)).toHaveLength(1);
      expect(prompts[1]!.match(/Caller tracing/g)).toHaveLength(1);
      expect(prompts[2]).not.toContain('Caller tracing');
      expect(prompts[3]).not.toContain('Caller tracing');
      expect(prompts[2]!.match(/Source relevance/g)).toHaveLength(1);
      expect(prompts[3]!.match(/Source relevance/g)).toHaveLength(1);
      expect(prompts[4]).not.toMatch(/Caller tracing|Source relevance/);
      expect(prompts[5]).not.toMatch(/Caller tracing|Source relevance/);

      // Durability: `restart()` stops the server and starts a fresh one over the SAME stateDir,
      // discarding the in-memory ExecutionRegistry. The reads below can therefore only be served
      // by ExecutionStore's durable `executions.db` row, never the in-memory registry.
      h = await h.restart();
      const inheritedRead = await fetch(`${h.baseUrl}/execution/${inherited.body.executionId}`, { headers: headers(h.token) });
      expect((await inheritedRead.json() as { execution: { method: string | null } }).execution.method).toBe('software-change@1');
      const overriddenRead = await fetch(`${h.baseUrl}/execution/${overridden.body.executionId}`, { headers: headers(h.token) });
      expect((await overriddenRead.json() as { execution: { method: string | null } }).execution.method).toBe('research@1');
      const clearedRead = await fetch(`${h.baseUrl}/execution/${cleared.body.executionId}`, { headers: headers(h.token) });
      expect((await clearedRead.json() as { execution: { method: string | null } }).execution.method).toBeNull();
    } finally { await h.close(); }
  });
});