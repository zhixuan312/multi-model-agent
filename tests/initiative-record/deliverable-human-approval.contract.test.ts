import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_EVENT_PAYLOAD_KEYS,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_OPERATIONS,
  InitiativeRecordStore,
  initiativeOperationRequestSchema,
} from '../../packages/core/src/initiative-record/index.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };

describe('SPEC-007 deliverable_approve human approval', () => {
  it('is the sole path to human_approved, rejects an empty or missing reason, rejects caller-set validation_state elsewhere, and later skips computation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-deliverable-approve-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const deliverable = store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      expect(() =>
        store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1', validation_state: 'human_approved' }, expected_revision: 0, provenance }),
      ).toThrow(/invalid_request/i);

      // Every other public Deliverable operation has a strict input shape too; the
      // forbidden state must not be smuggled through a read, attach, validate, or deliver request.
      const forbiddenStateRequests = [
        { operation: 'deliverable_get', input: { uuid: deliverable.uuid, validation_state: 'human_approved' } },
        { operation: 'deliverable_list', input: { initiative_id: initiative.uuid, validation_state: 'human_approved' } },
        { operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.uuid, artifact_id: deliverable.uuid, requirement: 'executable_prototype', validation_state: 'human_approved' }, expected_revision: deliverable.revision, provenance },
        { operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid, validation_state: 'human_approved' }, expected_revision: deliverable.revision, provenance },
        { operation: 'deliverable_deliver', input: { deliverable_id: deliverable.uuid, delivery_reference: 'ref', validation_state: 'human_approved' }, expected_revision: deliverable.revision, provenance },
      ];
      for (const request of forbiddenStateRequests) {
        expect(initiativeOperationRequestSchema.safeParse(request).success).toBe(false);
      }

      // The following calls deliberately use the server runtime, not store.execute(),
      // to prove this operation joined EXECUTE_OPERATIONS and the runtime dispatch switch.
      store.close();
      const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
      expect(() =>
        runtime.execute({ operation: 'deliverable_approve', input: { deliverable: { uuid: deliverable.uuid }, reason: '' }, expected_revision: deliverable.revision, provenance }),
      ).toThrow(/invalid_request/i);
      expect(() =>
        runtime.execute({ operation: 'deliverable_approve', input: { deliverable: { uuid: deliverable.uuid } }, expected_revision: deliverable.revision, provenance }),
      ).toThrow(/invalid_request/i);
      const approved = runtime.execute({ operation: 'deliverable_approve', input: { deliverable: { uuid: deliverable.uuid }, reason: 'stakeholder sign-off' }, expected_revision: deliverable.revision, provenance }) as {
        validation_state: string;
        revision: number;
      };
      expect(approved.validation_state).toBe('human_approved');
      const revalidated = runtime.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: approved.revision, provenance }) as {
        validation_state: string;
        validation_detail: string;
      };
      expect(revalidated.validation_state).toBe('human_approved');
      expect(revalidated.validation_detail).toMatch(/skip/i);
      runtime.close();
      const inspected = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const events = inspected.listEvents({ initiative_id: initiative.uuid }).filter((event) => event.event_type === 'deliverable_approved');
      expect(INITIATIVE_OPERATIONS).toContain('deliverable_approve');
      expect(INITIATIVE_EVENT_TYPES.deliverable_approve).toBe('deliverable_approved');
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.deliverable_approved).toEqual(['uuid', 'previous_validation_state', 'new_validation_state', 'reason']);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ uuid: deliverable.uuid, previous_validation_state: 'pending', new_validation_state: 'human_approved', reason: 'stakeholder sign-off' });
      const persisted = inspected.getDeliverable({ uuid: deliverable.uuid });
      expect(persisted.validation_state).toBe('human_approved');
      expect(persisted.validation_detail).toBe(revalidated.validation_detail);
      inspected.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});