// MMA Next gap-closure (§15: "deliverable_package is absent") — GAP 2 regression.
// Before this change, `deliverable_package` did not exist anywhere in `INITIATIVE_OPERATIONS`,
// so this whole test throws `invalid_request: unsupported mutation operation` against the
// pre-fix code. It passes once the operation, schema, store mutation, and dispatch wiring exist.
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

const provenance = {
  actor_type: 'agent',
  actor_id: 'seed',
  interface: 'test',
  initiated_by: 'seed',
  authorized_by: 'seed',
  timestamp: '2026-08-14T00:00:00.000Z',
  source: 'test',
};

describe('MMA Next gap-closure — deliverable_package (GAP 2)', () => {
  it('is a member of the frozen operation surface with the pinned event type and payload keys', () => {
    expect(INITIATIVE_OPERATIONS).toContain('deliverable_package');
    expect(INITIATIVE_EVENT_TYPES.deliverable_package).toBe('deliverable_packaged');
    expect(INITIATIVE_EVENT_PAYLOAD_KEYS.deliverable_packaged).toEqual(['uuid', 'delivery_contract', 'complete', 'missing']);
  });

  it('reports gaps (not a failure) for incomplete membership, then complete once every requirement is covered, contract-completeness only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-deliverable-package-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      }) as { uuid: string };
      const deliverable = store.execute({
        operation: 'deliverable_define',
        input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' },
        expected_revision: 0,
        provenance,
      }) as { uuid: string; revision: number };
      let revision = deliverable.revision;

      // Attach only 2 of the 5 requires entries — packaging must still SUCCEED and report gaps.
      const covered = ['executable_prototype', 'sample_data'];
      for (const requirement of covered) {
        const artifact = store.execute({
          operation: 'artifact_register',
          input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        store.execute({
          operation: 'deliverable_attach_artifact',
          input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement },
          expected_revision: revision,
          provenance,
        });
        revision = store.getDeliverable({ uuid: deliverable.uuid }).revision;
      }

      // Route this call through the SERVER RUNTIME, not store.execute() directly, to prove
      // `deliverable_package` joined EXECUTE_OPERATIONS and the runtime dispatch switch.
      store.close();
      const runtime = InitiativeRecordRuntime.open({ stateDir: dir });
      const packaged = runtime.execute({
        operation: 'deliverable_package',
        input: { deliverable_id: deliverable.uuid },
        expected_revision: revision,
        provenance,
      }) as {
        uuid: string;
        revision: number;
        complete: boolean;
        missing: string[];
        coverage: Array<{ requirement: string; members: Array<{ artifact_id: string; path_or_uri: string }> }>;
        packaging_guidance: string;
      };

      expect(packaged.complete).toBe(false);
      expect(packaged.missing.sort()).toEqual(['acceptance_evidence', 'known_limitations', 'usage_instructions'].sort());
      expect(packaged.coverage.find((entry) => entry.requirement === 'executable_prototype')?.members).toHaveLength(1);
      expect(packaged.coverage.find((entry) => entry.requirement === 'executable_prototype')?.members[0]).toMatchObject({
        path_or_uri: 'executable_prototype',
      });
      expect(packaged.coverage.find((entry) => entry.requirement === 'known_limitations')?.members).toEqual([]);
      expect(typeof packaged.packaging_guidance).toBe('string');
      expect(packaged.packaging_guidance.length).toBeGreaterThan(0);
      expect(packaged.revision).toBe(revision + 1);

      // Attach the remaining 3 requirements, then package again — now complete.
      let nextRevision = packaged.revision;
      for (const requirement of ['usage_instructions', 'known_limitations', 'acceptance_evidence']) {
        const artifact = runtime.execute({
          operation: 'artifact_register',
          input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        runtime.execute({
          operation: 'deliverable_attach_artifact',
          input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement },
          expected_revision: nextRevision,
          provenance,
        });
        nextRevision = (runtime.execute({ operation: 'deliverable_get', input: { uuid: deliverable.uuid } }) as { revision: number }).revision;
      }
      const complete = runtime.execute({
        operation: 'deliverable_package',
        input: { deliverable_id: deliverable.uuid },
        expected_revision: nextRevision,
        provenance,
      }) as { complete: boolean; missing: string[]; validation_state: string };
      expect(complete.complete).toBe(true);
      expect(complete.missing).toEqual([]);
      // Contract-completeness only: packaging never computes/sets validation_state (that stays
      // deliverable_validate's job) — the Deliverable is still `pending` after two packagings.
      expect(complete.validation_state).toBe('pending');

      runtime.close();
      const inspected = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const events = inspected.listEvents({ initiative_id: initiative.uuid }).filter((event) => event.event_type === 'deliverable_packaged');
      expect(events).toHaveLength(2);
      expect(events[0]!.payload).toEqual({
        uuid: deliverable.uuid,
        delivery_contract: 'runnable-prototype@1',
        complete: false,
        missing: expect.arrayContaining(['acceptance_evidence', 'known_limitations', 'usage_instructions']),
      });
      expect(events[1]!.payload).toEqual({ uuid: deliverable.uuid, delivery_contract: 'runnable-prototype@1', complete: true, missing: [] });
      inspected.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown Deliverable and a stale expected_revision the same way deliverable_validate does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-deliverable-package-errors-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      try {
        expect(() =>
          store.execute({
            operation: 'deliverable_package',
            input: { deliverable_id: '00000000-0000-0000-0000-000000000000' },
            expected_revision: 0,
            provenance,
          }),
        ).toThrow(/not_found/);

        const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
        const initiative = store.execute({
          operation: 'initiative_create',
          input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        const deliverable = store.execute({
          operation: 'deliverable_define',
          input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' },
          expected_revision: 0,
          provenance,
        }) as { uuid: string };
        expect(() =>
          store.execute({
            operation: 'deliverable_package',
            input: { deliverable_id: deliverable.uuid },
            expected_revision: 99,
            provenance,
          }),
        ).toThrow(/revision_conflict/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
