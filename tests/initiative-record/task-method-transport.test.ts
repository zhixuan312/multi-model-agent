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
    } finally { await client.close(); await h.close(); }
  });
});