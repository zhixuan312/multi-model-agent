import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u1', initiated_by: 'u1', authorized_by: 'u1', source: 'test' };
async function post(h: { baseUrl: string; token: string }, body: object) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify(body) });
  return { response, json: await response.json() as Record<string, any> };
}
async function mutation(h: { baseUrl: string; token: string }, operation: string, input: object, expected_revision = 0) {
  const result = await post(h, { operation, input, expected_revision, provenance });
  expect(result.response.status).toBe(200);
  return result.json;
}
function bootstrap(product: object, workspaces: object[], resources: object[], key: string) {
  return { operation: 'initiative_bootstrap', expected_revision: 0, idempotency_key: key, provenance, input: { product, workspaces, resources, initiative: { title: key, goal: 'Confirm the intake.', status: 'open', outcome: null } } };
}

describe('initiative_bootstrap HTTP contract', () => {
  it('proves mixed and all-existing branches, greenfield creation, resource attachment, rejection, revision, and replay', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await mutation(h, 'product_create', { name: 'Product A', slug: 'a' });
      const existing = await mutation(h, 'workspace_create', { product_id: product.uuid, name: 'Existing', slug: 'existing', description: 'Existing workspace.' });
      const otherProduct = await mutation(h, 'product_create', { name: 'Product B', slug: 'b' });
      const otherWorkspace = await mutation(h, 'workspace_create', { product_id: otherProduct.uuid, name: 'Other', slug: 'other', description: 'Other workspace.' });
      const mixed = await post(h, bootstrap({ existing: { uuid: product.uuid } }, [{ workspace_key: 'old', role: 'references', existing: { uuid: existing.uuid } }, { workspace_key: 'new', role: 'creates', create: { name: 'New', slug: 'new', description: 'New workspace.' } }], [{ workspace_key: 'old', type: 'repository', canonical_locator: 'https://example.test/old', description: 'Existing workspace resource.' }], 'mixed'));
      expect(mixed.response.status).toBe(200);
      const allExisting = await post(h, bootstrap({ existing: { uuid: product.uuid } }, [{ workspace_key: 'old', role: 'consumes', existing: { uuid: existing.uuid } }], [], 'all-existing'));
      expect(allExisting.response.status).toBe(200);
      const greenfield = await post(h, bootstrap({ create: { name: 'Green Product', slug: 'green' } }, [{ workspace_key: 'future', role: 'creates', create: { name: 'Future', slug: 'future', description: 'No repository yet.' } }], [], 'greenfield'));
      expect(greenfield.response.status).toBe(200);
      const beforeRejection = h.initiativeRecordSnapshot();
      const rejected = await post(h, bootstrap({ existing: { uuid: product.uuid } }, [{ workspace_key: 'wrong', role: 'references', existing: { uuid: otherWorkspace.uuid } }], [], 'cross-product'));
      expect(rejected.response.status).toBe(409);
      expect(rejected.json).toMatchObject({ error: { code: 'cross_product_workspace_link' } });
      expect(h.initiativeRecordSnapshot()).toEqual(beforeRejection);
      const replay = await post(h, bootstrap({ existing: { uuid: product.uuid } }, [{ workspace_key: 'old', role: 'references', existing: { uuid: existing.uuid } }], [], 'all-existing'));
      expect(replay.response.status).toBe(200);
      expect(replay.json.uuid).toBe(allExisting.json.uuid);
      const stale = await post(h, { ...bootstrap({ existing: { uuid: product.uuid } }, [{ workspace_key: 'old', role: 'references', existing: { uuid: existing.uuid } }], [], 'stale'), expected_revision: 999 });
      expect(stale.response.status).toBe(409);
    } finally {
      await h.close();
    }
  });
});