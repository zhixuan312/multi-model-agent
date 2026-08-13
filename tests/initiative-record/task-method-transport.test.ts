import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const provenance = { actor_type: 'agent', actor_id: 'a', interface: 'ignored', initiated_by: 'a', authorized_by: 'a', timestamp: 'ignored', source: 'test' };
const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });
async function mutate(h: { baseUrl: string; token: string }, operation: string, input: object, expected_revision: number) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation, input, expected_revision, provenance }) });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}
// Read-only ops validate against a `{ operation, input }` envelope (no `expected_revision`/
// `provenance` — that envelope is `.strict()` and rejects them as unrecognized keys).
async function query(h: { baseUrl: string; token: string }, operation: string, input: object) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation, input }) });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

describe('Task Method transport contract', () => {
  it('persists, clears, resumes, and transports Method values without adapter logic', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'method-transport', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['mma_initiative_method_get', 'mma_initiative_method_list', 'mma_initiative_initiative_task_set_method']));
      expect(tools.some((name) => /method_(register|create|update|delete)/.test(name))).toBe(false);
      // Boundary assertion (NOT a regression check — see contract Errors): this already holds
      // against 2872643f today because initiativeOperationRequestSchema is a closed
      // discriminated union that rejects any unregistered operation name. It pins FR-1's
      // no-caller-accessible-write guarantee at the public HTTP boundary going forward.
      for (const operation of ['method_register', 'method_update', 'method_delete']) {
        const rejected = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation, input: {}, expected_revision: 0, provenance }) });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_request' } });
      }
      const product = await mutate(h, 'product_create', { name: 'MMA', slug: 'method-transport' }, 0);
      const initiative = await mutate(h, 'initiative_create', { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, 0);
      const task = await mutate(h, 'initiative_task_create', { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [], method: 'software-change@1' }, 0);
      expect(task.method).toBe('software-change@1');
      const unknown = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_task_set_method', input: { initiative: { uuid: initiative.uuid }, task: { uuid: task.uuid }, method: 'missing@1' }, expected_revision: task.revision, provenance }) });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_method' } });
      const cleared = await client.callTool({ name: 'mma_initiative_initiative_task_set_method', arguments: { input: { initiative: { uuid: initiative.uuid }, task: { uuid: task.uuid }, method: null }, expected_revision: task.revision, provenance } });
      expect(cleared.isError).toBeFalsy();
      const resumed = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative.uuid } }) });
      expect((await resumed.json() as { tasks: Array<{ method: string | null }>; events: Array<{ event_type: string; payload: object }> }).tasks).toEqual([expect.objectContaining({ method: null })]);
      const record = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative.uuid } }) });
      expect((await record.json() as { events: Array<{ event_type: string; payload: object }> }).events).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'task_method_set', payload: { previous_method: 'software-change@1', new_method: null } })]));

      // The boundary check above (`method_register`/`update`/`delete` all 400) already held
      // before this change — it proves no caller-accessible WRITE endpoint exists, which is true
      // independent of whether `methods` is populated. It does NOT prove the populated registry
      // stays byte-unchanged once every public Method-touching operation has actually run against
      // it. Snapshot `method_list`'s full output, exercise the complete set of Method-touching
      // operations (method_get, method_list, initiative_task_create WITH a method,
      // initiative_task_set_method both setting and clearing), then snapshot again and assert
      // byte-identity — proving immutability in practice, not just the absence of a write op.
      const beforeMethods = await query(h, 'method_list', {});
      expect(beforeMethods).toHaveLength(9);
      const before = JSON.stringify(beforeMethods);

      await query(h, 'method_get', { id: 'software-change@1' });
      await query(h, 'method_list', {});
      // initiative_task_create WITH a method (revision 0 — task creation is a Task-entity
      // creation, so `expected_revision` is the NEW task's own starting revision, not the
      // Initiative's — see `requireCreateRevision` in sqlite-store.ts).
      const task2 = await mutate(h, 'initiative_task_create', { initiative_id: initiative.uuid, title: 'T2', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [], method: 'research@1' }, 0);
      expect(task2.method).toBe('research@1');
      // initiative_task_set_method SETTING (task3 is created with no method, then set for the
      // first time) and CLEARING, on a fresh task so this exercise is unambiguous.
      const task3 = await mutate(h, 'initiative_task_create', { initiative_id: initiative.uuid, title: 'T3', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, 0);
      expect(task3.method).toBeNull();
      const task3Set = await mutate(h, 'initiative_task_set_method', { initiative: { uuid: initiative.uuid }, task: { uuid: task3.uuid }, method: 'workflow-design@1' }, task3.revision);
      expect(task3Set.method).toBe('workflow-design@1');
      const task3Cleared = await mutate(h, 'initiative_task_set_method', { initiative: { uuid: initiative.uuid }, task: { uuid: task3.uuid }, method: null }, task3Set.revision);
      expect(task3Cleared.method).toBeNull();

      const afterMethods = await query(h, 'method_list', {});
      expect(JSON.stringify(afterMethods)).toBe(before);
    } finally { await client.close(); await h.close(); }
  });
});