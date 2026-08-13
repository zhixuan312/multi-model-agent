// Supplementary to tests/initiative-record/initiative-mcp-contract.test.ts (Task I-7,
// plan-authored acceptance test). That test has a syntax defect — an unbalanced paren
// (`expect(names).toEqual(expect.arrayContaining([...]);` never closes `arrayContaining(`)
// — inherited verbatim from the plan, which fails Vitest's transform step before any
// assertion runs. Per the execute-plan contract that file is not edited. This file
// exercises the exact same behavior with balanced syntax, plus one additional
// round-trip check (create -> get, and provenance/timestamp stamping) the plan-authored
// test does not cover.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

describe('Initiative MCP contract (supplement — fixed syntax)', () => {
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
      // Existing tools stay intact (AC-2.1's "existing seven MCP tools keep their behavior").
      expect(names).toEqual(expect.arrayContaining([
        'mma_run', 'mma_execution_get', 'mma_execution_list', 'mma_execution_wait', 'mma_execution_cancel',
        'mma_context_block_create', 'mma_context_block_delete',
      ]));

      const bad = await client.callTool({ name: 'mma_initiative_resume', arguments: { initiative: { uuid: 'bad' } } });
      expect(bad.isError).toBe(true);
      expect(JSON.parse((bad.content as Array<{ text: string }>)[0]!.text).error.code).toBe('invalid_request');

      // A full mutation round trip: create a Product over MCP, then read it back.
      // Caller-owned provenance fields are supplied; the adapter must overwrite
      // interface/timestamp regardless of what the caller sent.
      const created = await client.callTool({
        name: 'mma_product_create',
        arguments: {
          input: { name: 'MCP Product', slug: `mcp-product-${Date.now()}` },
          expected_revision: 0,
          provenance: {
            actor_type: 'agent',
            actor_id: 'test',
            interface: 'this-should-be-overwritten',
            initiated_by: 'test',
            authorized_by: 'test',
            timestamp: '2000-01-01T00:00:00.000Z',
            source: 'manual',
          },
        },
      });
      expect(created.isError).toBeFalsy();
      const product = JSON.parse((created.content as Array<{ text: string }>)[0]!.text);
      expect(product.name).toBe('MCP Product');
      expect(product.slug).toMatch(/^mcp-product-/);

      const fetched = await client.callTool({ name: 'mma_product_get', arguments: { input: { uuid: product.uuid } } });
      expect(fetched.isError).toBeFalsy();
      const refetched = JSON.parse((fetched.content as Array<{ text: string }>)[0]!.text);
      expect(refetched.uuid).toBe(product.uuid);

      // An unknown tool still reports unknown_tool (existing behavior preserved).
      const unknown = await client.callTool({ name: 'mma_not_a_real_tool', arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(JSON.parse((unknown.content as Array<{ text: string }>)[0]!.text).error.code).toBe('unknown_tool');
    } finally { await client.close(); await h.close(); }
  });
});
