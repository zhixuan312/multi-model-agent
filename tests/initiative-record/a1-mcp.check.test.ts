import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

describe('Phase A1 MCP surface', () => {
  it('publishes all new tools and accepts provenance without adapter-stamped fields', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'a1-check', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${h.token}` } } }));
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['mma_requirement_add', 'mma_acceptance_criterion_add', 'mma_decision_record', 'mma_decision_supersede', 'mma_evidence_add', 'mma_evidence_link', 'mma_risk_add', 'mma_risk_status', 'mma_verification_record', 'mma_requirement_get', 'mma_requirement_list', 'mma_acceptance_criterion_get', 'mma_acceptance_criterion_list', 'mma_decision_get', 'mma_decision_list', 'mma_evidence_get', 'mma_evidence_list', 'mma_evidence_links_list', 'mma_risk_get', 'mma_risk_list', 'mma_verification_get', 'mma_verification_list']));
      const schema = tools.find((tool) => tool.name === 'mma_requirement_add')!.inputSchema as {
        [x: string]: unknown;
        properties?: { [x: string]: unknown; provenance?: { properties: Record<string, unknown>; required: string[] } };
      };
      expect(schema.properties?.provenance).toBeDefined();
      expect(schema.properties!.provenance!.properties.interface).toBeUndefined();
      expect(schema.properties!.provenance!.properties.timestamp).toBeUndefined();
      expect(schema.properties!.provenance!.required).toEqual(expect.arrayContaining(['actor_type', 'actor_id', 'initiated_by', 'authorized_by', 'source']));
    } finally { await client.close(); await h.close(); }
  });
});