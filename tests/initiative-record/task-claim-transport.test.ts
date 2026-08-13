import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

describe('Task claim transport contract', () => {
  it('maps a typed claim conflict to HTTP 400 and exposes the four MCP tool names', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_task_claim', input: { uuid: 'not-a-uuid' }, expected_revision: 0, provenance: {} }) });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'invalid_request' } });
      const list = await fetch(`${h.baseUrl}/mcp`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['mma_initiative_task_claim', 'mma_initiative_task_release', 'mma_initiative_task_complete', 'mma_initiative_task_execution']));
    } finally { await h.close(); }
  });
});