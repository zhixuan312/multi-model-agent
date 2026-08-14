import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

describe('Initiative MCP contract', () => {
  it('publishes every frozen mma_<operation> name and returns the shared result shape', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'initiative-contract', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${h.token}` } } }));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(expect.arrayContaining([
        'mma_product_create', 'mma_product_get', 'mma_product_list', 'mma_workspace_create', 'mma_workspace_get', 'mma_workspace_list',
        'mma_resource_register', 'mma_resource_list', 'mma_initiative_create', 'mma_initiative_get', 'mma_initiative_list', 'mma_initiative_status',
        'mma_initiative_resume', 'mma_initiative_link_workspace', 'mma_initiative_relate', 'mma_initiative_relations',
        'mma_initiative_task_create', 'mma_initiative_task_get', 'mma_initiative_task_list', 'mma_artifact_register', 'mma_artifact_get',
      ]));
      const bad = await client.callTool({ name: 'mma_initiative_resume', arguments: { input: { initiative: { uuid: 'bad' } } } });
      expect(bad.isError).toBe(true);
      expect(JSON.parse((bad as { content: Array<{ text: string }> }).content[0]!.text).error.code).toBe('invalid_request');
    } finally { await client.close(); await h.close(); }
  });
});
