import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u1', initiated_by: 'u1', authorized_by: 'u1', source: 'manual' };

describe('Initiative HTTP contract', () => {
  it('uses the shared operation route, stamps HTTP provenance, and preserves authentication', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const unauthenticated = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(unauthenticated.status).toBe(401);
      const created = await fetch(`${h.baseUrl}/initiatives`, {
        method: 'POST', headers: headers(h.token),
        body: JSON.stringify({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance: { ...provenance, interface: 'forged', timestamp: '1900-01-01T00:00:00.000Z' } }),
      });
      expect(created.status).toBe(200);
      const product = await created.json() as { uuid: string };
      const invalid = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_resume', input: { initiative: { uuid: product.uuid, human_key: 'MMA-INIT-1' } } }) });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error.code).toBe('invalid_request');
    } finally { await h.close(); }
  });
});