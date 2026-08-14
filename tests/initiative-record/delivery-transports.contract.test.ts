import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { registerTargetAdapter } from '../../packages/core/src/initiative-record/index.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const REQUIREMENTS = ['executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence'];

async function call(baseUrl: string, token: string, body: unknown): Promise<{ status: number; json: { error?: { code: string }; uuid?: string; revision?: number } }> {
  const response = await fetch(`${baseUrl}/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as { error?: { code: string }; uuid?: string; revision?: number } };
}

describe('SPEC-007 Delivery transports', () => {
  it('advertises and dispatches the generated Delivery tools, and maps every reachable typed Delivery error to HTTP 400', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'spec007-delivery', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${h.token}` } } }));
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'mma_deliverable_define', 'mma_deliverable_get', 'mma_deliverable_list', 'mma_deliverable_attach_artifact',
        'mma_deliverable_validate', 'mma_deliverable_deliver', 'mma_delivery_contract_get', 'mma_delivery_contract_list',
        'mma_deliverable_approve',
      ]));

      // At least one real MCP dispatch, not just tool listing.
      const contractList = await client.callTool({ name: 'mma_delivery_contract_list', arguments: {} });
      expect(contractList.isError).not.toBe(true);

      const provenance = { actor_type: 'human', actor_id: 'u', initiated_by: 'u', authorized_by: 'u', source: 'test' };

      const mismatch = await call(h.baseUrl, h.token, { operation: 'deliverable_define', input: { initiative_id: '00000000-0000-0000-0000-000000000000', target_type: 'wrong', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance });
      expect(mismatch.status).toBe(400);
      expect(mismatch.json.error!.code).toMatch(/invalid_request/i);

      // This is a read-only union member: mutation-control keys would be rejected by
      // strict schema validation before the typed unknown-contract path is reached.
      const unknownContract = await call(h.baseUrl, h.token, { operation: 'delivery_contract_get', input: { id: 'not-a-real-contract@1' } });
      expect(unknownContract.status).toBe(400);
      expect(unknownContract.json.error!.code).toMatch(/unknown_delivery_contract/i);

      const product = await call(h.baseUrl, h.token, { operation: 'product_create', input: { name: 'P', slug: 'transport-p' }, expected_revision: 0, provenance });
      const initiative = await call(h.baseUrl, h.token, { operation: 'initiative_create', input: { product_id: product.json.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance });
      const deliverable = await call(h.baseUrl, h.token, { operation: 'deliverable_define', input: { initiative_id: initiative.json.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance });
      let revision = deliverable.json.revision!;
      for (const requirement of REQUIREMENTS) {
        const artifact = await call(h.baseUrl, h.token, { operation: 'artifact_register', input: { initiative_id: initiative.json.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement }, expected_revision: 0, provenance });
        await call(h.baseUrl, h.token, { operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.json.uuid, artifact_id: artifact.json.uuid, requirement }, expected_revision: revision, provenance });
        // The membership row carries no revision by contract; read the Deliverable's own back.
        revision = (await call(h.baseUrl, h.token, { operation: 'deliverable_get', input: { uuid: deliverable.json.uuid } })).json.revision!;
      }
      // Adapter registry is process-local (Ground truth) — registering in-process before the
      // HTTP call is enough; this is NOT the excluded duplicate-adapter-registration case.
      registerTargetAdapter({ target_type: 'runnable-prototype', validate: () => { throw new Error('adapter exploded'); } });
      const adapterFailure = await call(h.baseUrl, h.token, { operation: 'deliverable_validate', input: { deliverable_id: deliverable.json.uuid }, expected_revision: revision, provenance });
      expect(adapterFailure.status).toBe(400);
      expect(adapterFailure.json.error!.code).toMatch(/target_adapter_validation_failed/i);
    } finally { await client.close(); await h.close(); }
  });
});