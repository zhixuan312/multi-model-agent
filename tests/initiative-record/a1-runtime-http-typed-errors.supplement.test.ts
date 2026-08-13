// Supplementary to tests/initiative-record/a1-runtime-http.check.test.ts (Task I-6, ← AC-2.1).
// The plan-authored acceptance test only exercises `not_found` (404). This
// file covers the Contract's "Data mapping" clause the acceptance test
// leaves untested: the two new Phase A1 typed errors
// (`cross_initiative_evidence_link`, `cross_initiative_verification`) map to
// the same 409 conflict-status HTTP envelope convention as the existing
// `cross_product_workspace_link` error.
import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u', initiated_by: 'u', authorized_by: 'u', source: 'check' };

async function post(baseUrl: string, token: string, body: unknown) {
  const res = await fetch(`${baseUrl}/initiatives`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('Phase A1 runtime and HTTP: cross-Initiative typed errors map to 409', () => {
  it('maps evidence_link across Initiatives to cross_initiative_evidence_link / 409', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await post(h.baseUrl, h.token, { operation: 'product_create', input: { name: 'P', slug: `p-${Date.now()}` }, expected_revision: 0, provenance });
      const productId = (product.body as { uuid: string }).uuid;
      const initiativeA = await post(h.baseUrl, h.token, { operation: 'initiative_create', input: { product_id: productId, title: 'A', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance });
      const initiativeAId = (initiativeA.body as { uuid: string }).uuid;
      const initiativeB = await post(h.baseUrl, h.token, { operation: 'initiative_create', input: { product_id: productId, title: 'B', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance });
      const initiativeBId = (initiativeB.body as { uuid: string }).uuid;

      // Evidence belongs to Initiative A.
      const evidence = await post(h.baseUrl, h.token, {
        operation: 'evidence_add',
        input: { initiative_id: initiativeAId, kind: 'log', locator: 'x', content_hash: null, summary: 's' },
        expected_revision: 0,
        provenance,
      });
      const evidenceId = (evidence.body as { uuid: string }).uuid;

      // Requirement (the link target) belongs to Initiative B.
      const requirement = await post(h.baseUrl, h.token, {
        operation: 'requirement_add',
        input: { initiative_id: initiativeBId, statement: 'R' },
        expected_revision: 0,
        provenance,
      });
      const requirementId = (requirement.body as { uuid: string }).uuid;

      const link = await post(h.baseUrl, h.token, {
        operation: 'evidence_link',
        input: { evidence_id: evidenceId, target_type: 'requirement', target_id: requirementId },
        expected_revision: 0,
        provenance,
      });
      expect(link.status).toBe(409);
      expect((link.body as { error: { code: string } }).error.code).toBe('cross_initiative_evidence_link');
    } finally { await h.close(); }
  });

  it('maps verification_record across Initiatives to cross_initiative_verification / 409', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await post(h.baseUrl, h.token, { operation: 'product_create', input: { name: 'P', slug: `p-${Date.now()}` }, expected_revision: 0, provenance });
      const productId = (product.body as { uuid: string }).uuid;
      const initiativeA = await post(h.baseUrl, h.token, { operation: 'initiative_create', input: { product_id: productId, title: 'A', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance });
      const initiativeAId = (initiativeA.body as { uuid: string }).uuid;
      const initiativeB = await post(h.baseUrl, h.token, { operation: 'initiative_create', input: { product_id: productId, title: 'B', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance });
      const initiativeBId = (initiativeB.body as { uuid: string }).uuid;

      // Requirement + AcceptanceCriterion belong to Initiative A.
      const requirement = await post(h.baseUrl, h.token, {
        operation: 'requirement_add',
        input: { initiative_id: initiativeAId, statement: 'R' },
        expected_revision: 0,
        provenance,
      });
      const requirementId = (requirement.body as { uuid: string }).uuid;
      const criterion = await post(h.baseUrl, h.token, {
        operation: 'acceptance_criterion_add',
        input: { requirement_id: requirementId, statement: 'C', check_reference: 'ref' },
        expected_revision: 0,
        provenance,
      });
      const criterionId = (criterion.body as { uuid: string }).uuid;

      // Recorded against Initiative B — mismatch.
      const run = await post(h.baseUrl, h.token, {
        operation: 'verification_record',
        input: { initiative_id: initiativeBId, acceptance_criterion_id: criterionId, method: 'command', state: 'pass', detail: 'd' },
        expected_revision: 0,
        provenance,
      });
      expect(run.status).toBe(409);
      expect((run.body as { error: { code: string } }).error.code).toBe('cross_initiative_verification');
    } finally { await h.close(); }
  });
});
