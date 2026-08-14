import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_EVENT_PAYLOAD_KEYS,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_OPERATIONS,
  InitiativeRecordStore,
  registerTargetAdapter,
} from '../../packages/core/src/initiative-record/index.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };
describe('SPEC-007 computed validation and delivery history', () => {
  it('does not veto invalid delivery and preserves full prior history content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-delivery-history-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const deliverable = store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-software', delivery_contract: 'runnable-software@1' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      // Validate and deliver through the shared runtime boundary: this proves the two
      // runtime-only dispatch members were added rather than merely implemented in the store.
      store.close();
      const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
      const invalid = runtime.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: deliverable.revision, provenance }) as { validation_state: string; validation_detail: string; revision: number };
      expect(invalid).toMatchObject({ validation_state: 'invalid', validation_detail: 'no adapter registered' });
      const first = runtime.execute({ operation: 'deliverable_deliver', input: { deliverable_id: deliverable.uuid, delivery_reference: 'first' }, expected_revision: invalid.revision, provenance }) as { revision: number };
      runtime.close();
      const afterFirst = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const beforeSecond = afterFirst.listDeliveryHistory({ deliverable_id: deliverable.uuid });
      afterFirst.close();
      const secondRuntime = InitiativeRecordRuntime.open({ stateDir: dir });
      secondRuntime.execute({ operation: 'deliverable_deliver', input: { deliverable_id: deliverable.uuid, delivery_reference: 'second' }, expected_revision: first.revision, provenance });
      secondRuntime.close();
      const inspected = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const afterSecond = inspected.listDeliveryHistory({ deliverable_id: deliverable.uuid });
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond[0]).toEqual(beforeSecond[0]);
      expect(afterSecond[0]).toMatchObject({ delivery_reference: 'first', validation_state: 'invalid' });
      expect(afterSecond[1]).toMatchObject({ delivery_reference: 'second', validation_state: 'invalid' });
      const events = inspected
        .listEvents({ initiative_id: initiative.uuid })
        .filter((event) => event.event_type === 'deliverable_validated' || event.event_type === 'deliverable_delivered');
      expect(INITIATIVE_OPERATIONS).toEqual(expect.arrayContaining(['deliverable_validate', 'deliverable_deliver']));
      expect(INITIATIVE_EVENT_TYPES.deliverable_validate).toBe('deliverable_validated');
      expect(INITIATIVE_EVENT_TYPES.deliverable_deliver).toBe('deliverable_delivered');
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.deliverable_validated).toEqual(['uuid', 'validation_state', 'detail']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.deliverable_delivered).toEqual(['uuid', 'delivery_reference', 'validation_state']);
      expect(events.map((event) => event.event_type)).toEqual(['deliverable_validated', 'deliverable_delivered', 'deliverable_delivered']);
      expect(events[0]!.payload).toEqual({ uuid: deliverable.uuid, validation_state: 'invalid', detail: 'no adapter registered' });
      expect(events[1]!.payload).toEqual({ uuid: deliverable.uuid, delivery_reference: 'first', validation_state: 'invalid' });
      expect(events[2]!.payload).toEqual({ uuid: deliverable.uuid, delivery_reference: 'second', validation_state: 'invalid' });
      inspected.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not alter durable validation or Events when an adapter fails its contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-delivery-adapter-failure-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P2', slug: 'p2' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I2', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      let revision = 0;
      const deliverable = store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: revision, provenance }) as { uuid: string; revision: number };
      revision = deliverable.revision;
      for (const requirement of ['executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence']) {
        const artifact = store.execute({ operation: 'artifact_register', input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement }, expected_revision: 0, provenance }) as { uuid: string };
        revision = (store.execute({ operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement }, expected_revision: revision, provenance }) as { revision: number }).revision;
      }
      const baseline = store.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: revision, provenance }) as { validation_state: string; validation_detail: string; revision: number };
      expect(baseline).toMatchObject({ validation_state: 'valid', validation_detail: 'no adapter registered' });
      const eventsBefore = store.listEvents({ initiative_id: initiative.uuid });
      registerTargetAdapter({ target_type: 'runnable-prototype', validate: () => ({ valid: 'no', detail: 1 } as unknown as { valid: boolean; detail: string }) });
      expect(() => store.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: baseline.revision, provenance })).toThrow(/target_adapter_validation_failed/i);
      expect(store.getDeliverable({ uuid: deliverable.uuid })).toMatchObject({ validation_state: baseline.validation_state, validation_detail: baseline.validation_detail, revision: baseline.revision });
      expect(store.listEvents({ initiative_id: initiative.uuid })).toEqual(eventsBefore);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});