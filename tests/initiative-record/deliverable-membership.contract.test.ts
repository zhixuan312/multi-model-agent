import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_EVENT_PAYLOAD_KEYS,
  INITIATIVE_EVENT_TYPES,
  INITIATIVE_OPERATIONS,
  InitiativeRecordStore,
} from '../../packages/core/src/initiative-record/index.js';
import { InitiativeRecordRuntime } from '../../packages/server/src/application/initiative-record-runtime.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };
function setup(runtime: InitiativeRecordRuntime, slug: string) {
  const product = runtime.execute({ operation: 'product_create', input: { name: slug, slug }, expected_revision: 0, provenance }) as { uuid: string };
  return runtime.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: slug, goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
}

describe('SPEC-007 Deliverable membership', () => {
  it('persists only contract-matched same-Initiative members and exact Events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-deliverable-members-'));
    try {
      const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
      const initiative = setup(runtime, 'one');
      const other = setup(runtime, 'two');
      const artifact = runtime.execute({ operation: 'artifact_register', input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: 'a.txt', description: 'A' }, expected_revision: 0, provenance }) as { uuid: string };
      const otherArtifact = runtime.execute({ operation: 'artifact_register', input: { initiative_id: other.uuid, storage_mode: 'managed', path_or_uri: 'b.txt', description: 'B' }, expected_revision: 0, provenance }) as { uuid: string };
      const deliverable = runtime.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance }) as { uuid: string; validation_state: string; revision: number };
      expect(deliverable.validation_state).toBe('pending');
      const member = runtime.execute({ operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement: 'executable_prototype' }, expected_revision: deliverable.revision, provenance }) as { requirement: string };
      expect(member.requirement).toBe('executable_prototype');
      expect(() => runtime.execute({ operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.uuid, artifact_id: otherArtifact.uuid, requirement: 'sample_data' }, expected_revision: 1, provenance })).toThrow(/cross|initiative|invalid_request/i);
      expect(() => runtime.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'wrong', delivery_contract: 'runnable-prototype@1' }, expected_revision: 0, provenance })).toThrow(/invalid_request/i);
      // Execute all six through the runtime's shared discriminated union. In particular,
      // direct store helpers would not exercise EXECUTE_OPERATIONS or its dispatch switch.
      const fetched = runtime.execute({ operation: 'deliverable_get', input: { uuid: deliverable.uuid } }) as { uuid: string };
      expect(fetched.uuid).toBe(deliverable.uuid);
      const listed = runtime.execute({ operation: 'deliverable_list', input: { initiative_id: initiative.uuid } }) as Array<{ uuid: string }>;
      expect(listed.map((entry) => entry.uuid)).toEqual([deliverable.uuid]);
      const contract = runtime.execute({ operation: 'delivery_contract_get', input: { id: 'runnable-prototype@1' } }) as { id: string };
      expect(contract.id).toBe('runnable-prototype@1');
      const contracts = runtime.execute({ operation: 'delivery_contract_list', input: {} }) as Array<{ id: string }>;
      expect(contracts.map((entry) => entry.id)).toEqual(['runnable-prototype@1', 'runnable-software@1']);
      runtime.close();
      const inspected = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const events = inspected.listEvents({ initiative_id: initiative.uuid }).filter((event) => event.event_type.startsWith('deliverable_'));
      expect(INITIATIVE_OPERATIONS).toEqual(expect.arrayContaining([
        'deliverable_define', 'deliverable_get', 'deliverable_list', 'deliverable_attach_artifact',
        'delivery_contract_get', 'delivery_contract_list',
      ]));
      expect(INITIATIVE_EVENT_TYPES.deliverable_define).toBe('deliverable_defined');
      expect(INITIATIVE_EVENT_TYPES.deliverable_attach_artifact).toBe('deliverable_artifact_attached');
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.deliverable_defined).toEqual(['uuid', 'initiative_id', 'target_type', 'delivery_contract']);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.deliverable_artifact_attached).toEqual(['deliverable_id', 'artifact_id', 'requirement']);
      expect(events.map(({ event_type, payload }) => ({ event_type, payload }))).toEqual([
        {
          event_type: 'deliverable_defined',
          payload: {
            uuid: deliverable.uuid,
            initiative_id: initiative.uuid,
            target_type: 'runnable-prototype',
            delivery_contract: 'runnable-prototype@1',
          },
        },
        {
          event_type: 'deliverable_artifact_attached',
          payload: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement: 'executable_prototype' },
        },
      ]);
      inspected.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});