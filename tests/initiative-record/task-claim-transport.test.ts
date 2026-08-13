import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

describe('Task claim transport contract', () => {
  it('maps a typed claim conflict to HTTP 400 and exposes the four MCP tool names', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'task-claim-transport', version: '0.0.0' });
    try {
      const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_task_claim', input: { uuid: 'not-a-uuid' }, expected_revision: 0, provenance: {} }) });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'invalid_request' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${h.token}` } } }));
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['mma_initiative_task_claim', 'mma_initiative_task_release', 'mma_initiative_task_complete', 'mma_initiative_task_execution']));
    } finally { await client.close(); await h.close(); }
  });
});
