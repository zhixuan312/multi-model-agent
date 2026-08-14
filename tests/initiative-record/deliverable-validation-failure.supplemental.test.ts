import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, registerTargetAdapter } from '../../packages/core/src/initiative-record/index.js';

const provenance = {
  actor_type: 'human',
  actor_id: 'u1',
  interface: 'test',
  initiated_by: 'u1',
  authorized_by: 'u1',
  timestamp: '2026-08-14T00:00:00.000Z',
  source: 'test',
};

describe('deliverable validation adapter failures', () => {
  it('leaves durable validation and Events unchanged for malformed and throwing adapter verdicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-delivery-adapter-failure-supplemental-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({
        operation: 'product_create',
        input: { name: 'P', slug: 'p' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const deliverable = store.execute({
        operation: 'deliverable_define',
        input: {
          initiative_id: initiative.uuid,
          target_type: 'runnable-prototype',
          delivery_contract: 'runnable-prototype@1',
        },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; revision: number };

      for (const requirement of [
        'executable_prototype',
        'sample_data',
        'usage_instructions',
        'known_limitations',
        'acceptance_evidence',
      ]) {
        const artifact = store.execute({
          operation: 'artifact_register',
          input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        store.execute({
          operation: 'deliverable_attach_artifact',
          input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement },
          expected_revision: store.getDeliverable({ uuid: deliverable.uuid }).revision,
          provenance,
        });
      }

      const baseline = store.execute({
        operation: 'deliverable_validate',
        input: { deliverable_id: deliverable.uuid },
        expected_revision: store.getDeliverable({ uuid: deliverable.uuid }).revision,
        provenance,
      }) as { validation_state: string; validation_detail: string; revision: number };
      expect(baseline).toMatchObject({ validation_state: 'valid', validation_detail: 'no adapter registered' });
      const eventsBefore = store.listEvents({ initiative_id: initiative.uuid });

      let validationCalls = 0;
      registerTargetAdapter({
        target_type: 'runnable-prototype',
        validate: () => {
          validationCalls += 1;
          if (validationCalls === 1) return { valid: 'no', detail: 1 } as unknown as { valid: boolean; detail: string };
          throw new Error('adapter boom');
        },
      });

      for (const expectedMessage of [/target_adapter_validation_failed/i, /target_adapter_validation_failed/i]) {
        expect(() => store.execute({
          operation: 'deliverable_validate',
          input: { deliverable_id: deliverable.uuid },
          expected_revision: baseline.revision,
          provenance,
        })).toThrow(expectedMessage);
        expect(store.getDeliverable({ uuid: deliverable.uuid })).toMatchObject({
          validation_state: baseline.validation_state,
          validation_detail: baseline.validation_detail,
          revision: baseline.revision,
        });
        expect(store.listEvents({ initiative_id: initiative.uuid })).toEqual(eventsBefore);
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
