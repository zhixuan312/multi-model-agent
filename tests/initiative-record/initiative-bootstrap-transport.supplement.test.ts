// SPEC-006 Task I-4 (← AC-1.6, AC-1.7, AC-1.8, AC-1.9) — supplemental to
// `initiative-bootstrap-transport.contract.test.ts`.
//
// The plan-authored acceptance test snapshots `initiativeRecordSnapshot()` before/after only the
// REJECTED cross-Product request. Task I-4's contract (Behavior / invariants) requires the SAME
// before/after full-table snapshot discipline around EACH of the positive existing-Workspace
// branches — mixed (one new + one existing Workspace), all-existing, and Resource-registered-
// against-an-existing-Workspace — asserting the pre-seeded `workspaces` row stays byte-for-byte
// unchanged and that no new `workspace_created` Event appears for it. Without this, the positive
// branch is proven only by the request that fails, which is exactly the gap the contract calls
// out. This file adds that coverage without touching the plan-authored acceptance test.
import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
const provenance = { actor_type: 'human', actor_id: 'u1', initiated_by: 'u1', authorized_by: 'u1', source: 'test' };

async function post(h: { baseUrl: string; token: string }, body: object) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify(body) });
  return { response, json: (await response.json()) as Record<string, any> };
}
async function mutation(h: { baseUrl: string; token: string }, operation: string, input: object, expected_revision = 0) {
  const result = await post(h, { operation, input, expected_revision, provenance });
  expect(result.response.status).toBe(200);
  return result.json;
}
function bootstrap(product: object, workspaces: object[], resources: object[], key: string) {
  return {
    operation: 'initiative_bootstrap',
    expected_revision: 0,
    idempotency_key: key,
    provenance,
    input: { product, workspaces, resources, initiative: { title: key, goal: 'Confirm the intake.', status: 'open', outcome: null } },
  };
}

function workspaceRow(snapshot: Record<string, unknown[]>, uuid: string): unknown {
  return (snapshot.workspaces as Array<{ uuid: string }>).find((row) => row.uuid === uuid);
}
function workspaceCreatedEventCount(snapshot: Record<string, unknown[]>, workspaceUuid: string): number {
  return (snapshot.events as Array<{ entity_type: string; entity_id: string; event_type: string }>).filter(
    (event) => event.entity_type === 'Workspace' && event.entity_id === workspaceUuid && event.event_type === 'workspace_created',
  ).length;
}

describe('initiative_bootstrap preserves pre-seeded Workspaces across positive existing-Workspace branches', () => {
  it('leaves the pre-seeded workspace row and its workspace_created Event untouched by mixed, all-existing, and resource-on-existing-workspace requests', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const product = await mutation(h, 'product_create', { name: 'Product A', slug: 'a' });
      const existing = await mutation(h, 'workspace_create', {
        product_id: product.uuid,
        name: 'Existing',
        slug: 'existing',
        description: 'Existing workspace.',
      });

      // Mixed: one new + one existing Workspace in the same request.
      const beforeMixed = h.initiativeRecordSnapshot();
      const mixed = await post(
        h,
        bootstrap(
          { existing: { uuid: product.uuid } },
          [
            { workspace_key: 'old', role: 'references', existing: { uuid: existing.uuid } },
            { workspace_key: 'new', role: 'creates', create: { name: 'New', slug: 'new', description: 'New workspace.' } },
          ],
          [],
          'existing-guard-mixed',
        ),
      );
      expect(mixed.response.status).toBe(200);
      const afterMixed = h.initiativeRecordSnapshot();
      expect(workspaceRow(afterMixed, existing.uuid)).toEqual(workspaceRow(beforeMixed, existing.uuid));
      expect(workspaceCreatedEventCount(afterMixed, existing.uuid)).toBe(workspaceCreatedEventCount(beforeMixed, existing.uuid));

      // All-existing: no `creates` Workspace at all.
      const beforeAllExisting = h.initiativeRecordSnapshot();
      const allExisting = await post(
        h,
        bootstrap({ existing: { uuid: product.uuid } }, [{ workspace_key: 'old', role: 'consumes', existing: { uuid: existing.uuid } }], [], 'existing-guard-all-existing'),
      );
      expect(allExisting.response.status).toBe(200);
      const afterAllExisting = h.initiativeRecordSnapshot();
      expect(workspaceRow(afterAllExisting, existing.uuid)).toEqual(workspaceRow(beforeAllExisting, existing.uuid));
      expect(workspaceCreatedEventCount(afterAllExisting, existing.uuid)).toBe(workspaceCreatedEventCount(beforeAllExisting, existing.uuid));

      // Resource registered against an existing Workspace: only the Resource (and dependent
      // Initiative/link) rows may appear — the Workspace row and its Event must not move.
      const beforeResource = h.initiativeRecordSnapshot();
      const resourceOnExisting = await post(
        h,
        bootstrap(
          { existing: { uuid: product.uuid } },
          [{ workspace_key: 'old', role: 'references', existing: { uuid: existing.uuid } }],
          [{ workspace_key: 'old', type: 'repository', canonical_locator: 'https://example.test/resource-guard', description: 'Resource against an existing workspace.' }],
          'existing-guard-resource',
        ),
      );
      expect(resourceOnExisting.response.status).toBe(200);
      const afterResource = h.initiativeRecordSnapshot();
      expect(workspaceRow(afterResource, existing.uuid)).toEqual(workspaceRow(beforeResource, existing.uuid));
      expect(workspaceCreatedEventCount(afterResource, existing.uuid)).toBe(workspaceCreatedEventCount(beforeResource, existing.uuid));
      expect((afterResource.resources as unknown[]).length).toBe((beforeResource.resources as unknown[]).length + 1);
    } finally {
      await h.close();
    }
  });
});
