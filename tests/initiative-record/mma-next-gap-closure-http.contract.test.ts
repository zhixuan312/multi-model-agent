// MMA Next gap-closure — HTTP exposure regression. Proves the four new operations reach real
// callers through the SAME `/initiatives` envelope every other operation uses: `initiative_export`
// as a third dedicated read (like `initiative_resume`/`initiative_gate_status`), and the two new
// typed errors mapped onto the pinned HTTP status codes (validation-shaped 400,
// conflict-shaped 409). Before this change, `initiative_export`/`verification_run`/
// `initiative_import` all 400 with `invalid_request` (unknown operation) against the pre-fix
// code — this test fails there and passes once the operations, runtime dispatch, and HTTP error
// mapping all exist.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u1', initiated_by: 'u1', authorized_by: 'u1', source: 'manual' };

async function post(baseUrl: string, token: string, body: unknown) {
  const res = await fetch(`${baseUrl}/initiatives`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, json };
}

describe('MMA Next gap-closure — HTTP exposure (POST /initiatives)', () => {
  it('serves initiative_export as a dedicated read, and maps verification_method_not_runnable to 400 and initiative_already_exists to 409', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = (await post(h.baseUrl, h.token, {
        operation: 'product_create',
        input: { name: 'MMA', slug: 'mma-gap-closure-http' },
        expected_revision: 0,
        provenance,
      })).json as { uuid: string };
      const initiative = (await post(h.baseUrl, h.token, {
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      })).json as { uuid: string };
      const requirement = (await post(h.baseUrl, h.token, {
        operation: 'requirement_add',
        input: { initiative_id: initiative.uuid, statement: 'Must expose over HTTP.' },
        expected_revision: 0,
        provenance,
      })).json as { uuid: string };
      const criterion = (await post(h.baseUrl, h.token, {
        operation: 'acceptance_criterion_add',
        input: { requirement_id: requirement.uuid, statement: 'HTTP exposure works.', check_reference: 'mma-next-gap-closure-http.contract.test.ts' },
        expected_revision: 0,
        provenance,
      })).json as { uuid: string };

      // GAP 4 — initiative_export: a 200 read, same envelope as every other operation, unwrapped
      // by the HTTP handler's dedicated branch (never `execute()`).
      const exported = await post(h.baseUrl, h.token, { operation: 'initiative_export', input: { initiative: { uuid: initiative.uuid } } });
      expect(exported.status).toBe(200);
      const snapshot = exported.json as { schema_version: number; initiative: { uuid: string } };
      expect(snapshot.initiative.uuid).toBe(initiative.uuid);
      expect(typeof snapshot.schema_version).toBe('number');

      // GAP 3 — verification_run: 'human' is not machine-runnable -> validation-shaped 400.
      const notRunnable = await post(h.baseUrl, h.token, {
        operation: 'verification_run',
        input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'human', command: 'true' },
        expected_revision: 0,
        provenance,
      });
      expect(notRunnable.status).toBe(400);
      expect((notRunnable.json as { error: { code: string } }).error.code).toBe('verification_method_not_runnable');

      // A verification_run is confined to the Initiative's own workspace (audit M1-1), so link a
      // Workspace whose Resource declares a local path before running anything.
      const workspace = await post(h.baseUrl, h.token, {
        operation: 'workspace_create',
        input: { product_id: product.uuid, name: 'W', slug: 'w', description: 'Workspace the verification runs inside.' },
        expected_revision: 0, provenance,
      });
      await post(h.baseUrl, h.token, {
        operation: 'resource_register',
        input: { workspace_id: (workspace.json as { uuid: string }).uuid, type: 'repository', canonical_locator: 'https://example.test/w', local_path: process.cwd(), description: 'Local checkout.' },
        expected_revision: 0, provenance,
      });
      await post(h.baseUrl, h.token, {
        operation: 'initiative_link_workspace',
        input: { initiative_id: initiative.uuid, workspace_id: (workspace.json as { uuid: string }).uuid, role: 'modifies' },
        expected_revision: 0, provenance,
      });

      // A real 'command' run succeeds as a normal mutation over the same envelope. `true` is a
      // program, not a shell snippet — the store executes argv, never a shell.
      const ran = await post(h.baseUrl, h.token, {
        operation: 'verification_run',
        input: { initiative_id: initiative.uuid, acceptance_criterion_id: criterion.uuid, method: 'command', command: 'true' },
        expected_revision: 0,
        provenance,
      });
      expect(ran.status).toBe(200);
      expect((ran.json as { state: string }).state).toBe('pass');

      // GAP 4 — initiative_import: re-importing the SAME Initiative (already present) ->
      // conflict-shaped 409, never a silent merge.
      const reimported = await post(h.baseUrl, h.token, {
        operation: 'initiative_import',
        input: { snapshot },
        expected_revision: 0,
        provenance,
      });
      expect(reimported.status).toBe(409);
      expect((reimported.json as { error: { code: string } }).error.code).toBe('initiative_already_exists');
    } finally {
      await h.close();
    }
  });

  it('publishes the four new generated MCP tools and dispatches mma_initiative_export through its dedicated handler', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'mma-next-gap-closure-contract', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${h.token}` } } }),
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(['mma_verification_run', 'mma_deliverable_package', 'mma_initiative_export', 'mma_initiative_import']),
      );

      const product = await client.callTool({ name: 'mma_product_create', arguments: { input: { name: 'MMA', slug: 'mma-mcp-gap-closure' }, expected_revision: 0, provenance } });
      const productUuid = (JSON.parse((product.content as Array<{ text: string }>)[0]!.text) as { uuid: string }).uuid;
      const initiative = await client.callTool({
        name: 'mma_initiative_create',
        arguments: { input: { product_id: productUuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance },
      });
      const initiativeUuid = (JSON.parse((initiative.content as Array<{ text: string }>)[0]!.text) as { uuid: string }).uuid;

      const exported = await client.callTool({ name: 'mma_initiative_export', arguments: { input: { initiative: { uuid: initiativeUuid } } } });
      expect(exported.isError).toBeFalsy();
      const snapshot = JSON.parse((exported.content as Array<{ text: string }>)[0]!.text) as { initiative: { uuid: string } };
      expect(snapshot.initiative.uuid).toBe(initiativeUuid);
    } finally {
      await client.close();
      await h.close();
    }
  });
});
