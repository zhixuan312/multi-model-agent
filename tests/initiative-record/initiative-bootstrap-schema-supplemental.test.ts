import { describe, expect, it } from 'vitest';
import {
  initiativeMutationRequestSchema,
  initiativeOperationRequestSchema,
} from '../../packages/core/src/initiative-record/index.js';

const provenance = {
  actor_type: 'human',
  actor_id: 'u1',
  interface: 'test',
  initiated_by: 'u1',
  authorized_by: 'u1',
  timestamp: '2026-08-14T00:00:00.000Z',
  source: 'test',
};

function request(input: Record<string, unknown> = {}) {
  return {
    operation: 'initiative_bootstrap',
    expected_revision: 0,
    provenance,
    input: {
      product: { create: { name: 'New Product', slug: 'new-product' } },
      workspaces: [
        {
          workspace_key: 'primary',
          role: 'creates',
          create: { name: 'New Workspace', slug: 'new-workspace', description: 'A future repository.' },
        },
      ],
      initiative: { title: 'Confirmed intake', goal: 'Create the outcome.', status: 'open', outcome: null },
      ...input,
    },
  };
}

describe('initiative_bootstrap supplemental schema coverage', () => {
  it('is accepted through both shared request unions', () => {
    const validRequest = request();
    expect(initiativeMutationRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(initiativeOperationRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it.each([
    ['no Product branch', { product: {} }],
    ['both Product branches', { product: { create: { name: 'P', slug: 'p' }, existing: { uuid: '00000000-0000-0000-0000-000000000000' } } }],
    ['no Workspace branch', { workspaces: [{ workspace_key: 'primary', role: 'creates' }] }],
    ['an invalid Workspace role', { workspaces: [{ workspace_key: 'primary', role: 'owns', create: { name: 'W', slug: 'w', description: 'W.' } }] }],
    ['no Workspaces', { workspaces: [] }],
    ['an unknown nested Product key', { product: { create: { name: 'P', slug: 'p', extra: true } } }],
    ['an unknown Resource key', { resources: [{ workspace_key: 'primary', type: 'repository', canonical_locator: 'https://example.test/repo', description: 'Repo.', extra: true }] }],
  ])('rejects %s', (_description, input) => {
    expect(initiativeMutationRequestSchema.safeParse(request(input)).success).toBe(false);
  });
});
