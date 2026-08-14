import { describe, expect, it } from 'vitest';
import { INITIATIVE_OPERATIONS, initiativeMutationRequestSchema } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'initiative_bootstrap', expected_revision: 0, idempotency_key: 'confirmed-intake', provenance,
    input: {
      product: { create: { name: 'New Product', slug: 'new-product' } },
      workspaces: [{ workspace_key: 'primary', role: 'creates', create: { name: 'New Workspace', slug: 'new-workspace', description: 'A future repository.' } }],
      resources: [],
      initiative: { title: 'Confirmed intake', goal: 'Create the product outcome.', status: 'open', outcome: null },
      requirements: [],
      ...overrides,
    },
  };
}

describe('initiative_bootstrap request contract', () => {
  it('is a member of INITIATIVE_OPERATIONS and accepts a complete valid confirmed draft', () => {
    expect(INITIATIVE_OPERATIONS).toContain('initiative_bootstrap');
    expect(initiativeMutationRequestSchema.safeParse(validRequest()).success).toBe(true);
  });

  it('rejects a duplicate request workspace_key', () => {
    const request = validRequest({
      workspaces: [
        { workspace_key: 'dup', role: 'creates', create: { name: 'A', slug: 'a', description: 'A.' } },
        { workspace_key: 'dup', role: 'creates', create: { name: 'B', slug: 'b', description: 'B.' } },
      ],
    });
    expect(initiativeMutationRequestSchema.safeParse(request).success).toBe(false);
  });

  it('rejects a Resource naming a workspace_key outside the request', () => {
    const request = validRequest({ resources: [{ workspace_key: 'missing', type: 'repository', canonical_locator: 'https://example.test/x', description: 'x' }] });
    expect(initiativeMutationRequestSchema.safeParse(request).success).toBe(false);
  });

  it('rejects a workspaces entry carrying both create and existing', () => {
    const request = validRequest({ workspaces: [{ workspace_key: 'both', role: 'creates', create: { name: 'A', slug: 'a', description: 'A.' }, existing: { uuid: '00000000-0000-0000-0000-000000000000' } }] });
    expect(initiativeMutationRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(['tasks', 'executions', 'decisions', 'evidence', 'deliverables'])('rejects the excluded entity key %s', (key) => {
    const request = validRequest({ [key]: [] });
    expect(initiativeMutationRequestSchema.safeParse(request).success).toBe(false);
  });
});