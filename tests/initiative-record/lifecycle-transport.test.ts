import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });

describe('Lifecycle transports', () => {
  it('publishes every lifecycle tool and returns typed 400 errors with adapter provenance', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'lifecycle-transport', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['mma_initiative_phase_enter', 'mma_initiative_phase_satisfy', 'mma_initiative_phase_reopen', 'mma_initiative_phase_skip', 'mma_initiative_focus_set', 'mma_initiative_set_lifecycle_contract', 'mma_initiative_gate_status']));
      const http = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_phase_satisfy', input: { initiative: { uuid: '00000000-0000-4000-8000-000000000001' }, phase: 'discover' }, expected_revision: 0, provenance: {} }) });
      expect(http.status).toBe(400);
      expect(await http.json()).toMatchObject({ error: { code: 'invalid_request' } });
      const productResponse = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'product_create', input: { name: 'MMA', slug: 'mma-lifecycle-transport' }, expected_revision: 0, provenance: { actor_type: 'agent', actor_id: 'a', interface: 'ignored', initiated_by: 'a', authorized_by: 'a', timestamp: 'ignored', source: 'test' } }) });
      const product = await productResponse.json() as { uuid: string };
      const initiativeResponse = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance: { actor_type: 'agent', actor_id: 'a', interface: 'ignored', initiated_by: 'a', authorized_by: 'a', timestamp: 'ignored', source: 'test' } }) });
      const initiative = await initiativeResponse.json() as { uuid: string; revision: number };
      const mcp = await client.callTool({ name: 'mma_initiative_set_lifecycle_contract', arguments: { input: { initiative: { uuid: initiative.uuid }, lifecycle_contract: 'missing@1' }, expected_revision: initiative.revision, provenance: { actor_type: 'agent', actor_id: 'a', initiated_by: 'a', authorized_by: 'a', source: 'test' } } });
      expect(mcp.isError).toBe(true);
      expect(JSON.parse(mcp.content[0]!.text)).toMatchObject({ error: { code: 'unknown_lifecycle_contract' } });
    } finally { await client.close(); await h.close(); }
  });
});