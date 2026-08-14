import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  InitiativeInvalidRequestError,
  registerTargetAdapter,
  TargetAdapterValidationFailedError,
  UnknownDeliveryContractError,
} from '@zhixuan92/multi-model-agent-core';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';
import { buildMcpServer, type McpAdapterDeps } from '../../packages/server/src/mcp/mcp-adapter.js';
import { MCP_CAPABILITIES_TOOLS_ONLY } from '../../packages/server/src/mcp/tool-surface.js';
import { buildInitiativeHandler } from '../../packages/server/src/http/handlers/initiative-record.js';

const provenance = {
  actor_type: 'human',
  actor_id: 'u',
  initiated_by: 'u',
  authorized_by: 'u',
  source: 'test',
  interface: 'http',
  timestamp: '2026-08-14T00:00:00.000Z',
};

describe('SPEC-007 Delivery transport supplemental MCP coverage', () => {
  it('maps every reachable validation-shaped Delivery error to HTTP 400', async () => {
    for (const error of [
      new UnknownDeliveryContractError({ delivery_contract: 'not-a-real-contract@1' }),
      new TargetAdapterValidationFailedError({ target_type: 'runnable-prototype' }),
      new InitiativeInvalidRequestError({ field_errors: { delivery_contract: ['does not match target_type'] } }),
    ]) {
      let status = 0;
      let payload: unknown;
      const handler = buildInitiativeHandler({
        initiativeRuntime: {
          execute: () => {
            throw error;
          },
        },
      } as never);
      await handler({} as never, {
        writeHead: (nextStatus: number) => {
          status = nextStatus;
        },
        end: (body: string) => {
          payload = JSON.parse(body);
        },
      } as never, {}, {
        body: { operation: 'delivery_contract_get', input: { id: 'not-a-real-contract@1' } },
        url: new URL('http://localhost/initiatives'),
        callerClient: 'other',
      });
      expect(status).toBe(400);
      expect(payload).toMatchObject({ error: { code: error.code } });
    }
  });

  it('dispatches an empty-input tool and maps the reachable typed Delivery errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delivery-mcp-'));
    const initiativeRuntime = InitiativeRecordRuntime.open({ stateDir: dir });
    const deps = {
      initiativeRuntime,
      serverVersion: 'test',
      capabilities: MCP_CAPABILITIES_TOOLS_ONLY,
    } as McpAdapterDeps;
    const server = buildMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'delivery-transport-test', version: '0.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.callTool({ name: 'mma_delivery_contract_list', arguments: {} });
      expect(listed.isError).not.toBe(true);

      const unknown = await client.callTool({
        name: 'mma_delivery_contract_get',
        arguments: { input: { id: 'not-a-real-contract@1' } },
      }) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]?.text).toContain('unknown_delivery_contract');

      const product = initiativeRuntime.execute({
        operation: 'product_create',
        input: { name: 'Product', slug: 'delivery-mcp-product' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const initiative = initiativeRuntime.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'Initiative', goal: 'Goal', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const deliverable = initiativeRuntime.execute({
        operation: 'deliverable_define',
        input: {
          initiative_id: initiative.uuid,
          target_type: 'runnable-prototype',
          delivery_contract: 'runnable-prototype@1',
        },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; revision: number };
      let revision = deliverable.revision;
      for (const requirement of ['executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence']) {
        const artifact = initiativeRuntime.execute({
          operation: 'artifact_register',
          input: {
            initiative_id: initiative.uuid,
            storage_mode: 'managed',
            path_or_uri: requirement,
            description: requirement,
          },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        initiativeRuntime.execute({
          operation: 'deliverable_attach_artifact',
          input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement },
          expected_revision: revision,
          provenance,
        });
        revision = (initiativeRuntime.execute({
          operation: 'deliverable_get',
          input: { uuid: deliverable.uuid },
        }) as { revision: number }).revision;
      }

      registerTargetAdapter({
        target_type: 'runnable-prototype',
        validate: () => {
          throw new Error('adapter exploded');
        },
      });
      const adapterFailure = await client.callTool({
        name: 'mma_deliverable_validate',
        arguments: {
          input: { deliverable_id: deliverable.uuid },
          expected_revision: revision,
          provenance: {
            actor_type: 'human',
            actor_id: 'u',
            initiated_by: 'u',
            authorized_by: 'u',
            source: 'test',
          },
        },
      }) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(adapterFailure.isError).toBe(true);
      expect(adapterFailure.content[0]?.text).toContain('target_adapter_validation_failed');
    } finally {
      await client.close();
      await server.close();
      initiativeRuntime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
