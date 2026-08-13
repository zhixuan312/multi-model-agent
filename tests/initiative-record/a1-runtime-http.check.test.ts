import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u', initiated_by: 'u', authorized_by: 'u', source: 'check' };

describe('Phase A1 runtime and HTTP parity', () => {
  it('dispatches a Phase A1 write and read through POST /initiatives with typed failures', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'product_create', input: { name: 'P', slug: `p-${Date.now()}` }, expected_revision: 0, provenance }) });
      const productBody = await product.json() as { uuid: string };
      const initiative = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'initiative_create', input: { product_id: productBody.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) });
      const initiativeBody = await initiative.json() as { uuid: string };
      const added = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'requirement_add', input: { initiative_id: initiativeBody.uuid, statement: 'S' }, expected_revision: 0, provenance }) });
      const requirement = await added.json() as { uuid: string };
      const fetched = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'requirement_get', input: { uuid: requirement.uuid } }) });
      expect(added.status).toBe(200);
      expect(fetched.status).toBe(200);
      expect((await fetched.json() as { uuid: string }).uuid).toBe(requirement.uuid);
      const missing = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation: 'requirement_get', input: { uuid: '00000000-0000-4000-8000-000000000099' } }) });
      expect(missing.status).toBe(404);
      expect((await missing.json() as { error: { code: string } }).error.code).toBe('not_found');
    } finally { await h.close(); }
  });
});