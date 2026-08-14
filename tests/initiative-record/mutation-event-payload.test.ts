import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

// Supplementary coverage for Task I-3 (← AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.9, AC-1.11) beyond the two
// plan-authored acceptance tests in mutation-contract.test.ts. The Contract's Data mapping bullet requires
// "Map each mutation to the exact event type and exact payload-key set defined in Task I-1" for EVERY
// mutating operation, but the floor tests only exercise product_create and initiative_create. This file
// exercises the remaining event-type/payload pairs from the frozen table (SPEC-001 Data model), plus the
// existing-key artifact_register revision path and the not_found path a stale-revision `initiative_status`
// call requires when the target record does not exist.

const provenance = {
  actor_type: 'human' as const,
  actor_id: 'u1',
  interface: 'http',
  initiated_by: 'u1',
  authorized_by: 'u1',
  timestamp: '2026-08-12T00:00:00.000Z',
  source: 'manual',
};

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-event-payload-'));
  const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Initiative mutation event/payload contract (Task I-3 supplementary)', () => {
  it('emits the frozen event_type and exact payload keys for every Group 001A mutation', () => {
    const { store, cleanup } = openStore();
    try {
      const product = store.execute({
        operation: 'product_create',
        input: { name: 'MMA', slug: 'mma' },
        expected_revision: 0,
        provenance,
      });
      const workspace = store.execute({
        operation: 'workspace_create',
        input: { product_id: product.uuid, name: 'Engine', slug: 'engine', description: 'd' },
        expected_revision: 0,
        provenance,
      });
      const resource = store.execute({
        operation: 'resource_register',
        input: { workspace_id: workspace.uuid, type: 'git_repository', canonical_locator: 'repo', description: 'd' },
        expected_revision: 0,
        provenance,
      });
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'g', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      const related = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'Related', goal: 'g', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      store.execute({
        operation: 'initiative_status',
        input: { uuid: initiative.uuid, status: 'closed', outcome: 'delivered' },
        expected_revision: 0,
        provenance,
      });
      store.execute({
        operation: 'initiative_link_workspace',
        input: { initiative_id: initiative.uuid, workspace_id: workspace.uuid, role: 'references' },
        expected_revision: 0,
        provenance,
      });
      store.execute({
        operation: 'initiative_relate',
        input: { from_id: initiative.uuid, to_id: related.uuid, type: 'related_to' },
        expected_revision: 0,
        provenance,
      });
      store.execute({
        operation: 'initiative_task_create',
        input: {
          initiative_id: initiative.uuid,
          title: 'Task',
          goal: 'g',
          status: 'open',
          outcome: null,
          workspace_ids: [workspace.uuid],
          resource_ids: [resource.uuid],
        },
        expected_revision: 0,
        provenance,
      });
      const artifactCreated = store.execute({
        operation: 'artifact_register',
        input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', content_hash: 'one', description: 'a' },
        expected_revision: 0,
        provenance,
      });
      store.execute({
        operation: 'artifact_register',
        input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', content_hash: 'two', description: 'a' },
        expected_revision: artifactCreated.revision,
        provenance,
      });

      const events = store.listEvents({});
      expect(events.map((event) => event.event_type)).toEqual([
        'product_created',
        'workspace_created',
        'resource_registered',
        'initiative_created',
        'initiative_created',
        'initiative_status_changed',
        'initiative_workspace_linked',
        'initiative_related',
        'task_created',
        'artifact_registered',
        'artifact_updated',
      ]);

      const expectedPayloadKeys: Record<string, string[]> = {
        product_created: ['uuid', 'slug'],
        workspace_created: ['uuid', 'product_id', 'slug'],
        resource_registered: ['uuid', 'workspace_id', 'canonical_locator'],
        initiative_created: ['uuid', 'human_key', 'product_id'],
        initiative_status_changed: ['uuid', 'human_key', 'status', 'outcome'],
        initiative_workspace_linked: ['initiative_id', 'workspace_id', 'role'],
        initiative_related: ['from_id', 'to_id', 'type'],
        task_created: ['uuid', 'initiative_id', 'status'],
        artifact_registered: ['uuid', 'initiative_id', 'path_or_uri', 'storage_mode'],
        artifact_updated: ['uuid', 'initiative_id', 'path_or_uri', 'content_hash'],
      };
      for (const event of events) {
        expect(Object.keys(event.payload).sort()).toEqual([...expectedPayloadKeys[event.event_type]].sort());
      }

      // Every mutation carries all seven frozen provenance fields onto its Event (AC-1.6), and event_sequence
      // is monotonic for the installation.
      events.forEach((event, index) => {
        expect(event.event_sequence).toBe(index + 1);
        expect(event).toMatchObject({
          actor_type: provenance.actor_type,
          actor_id: provenance.actor_id,
          interface: provenance.interface,
          initiated_by: provenance.initiated_by,
          authorized_by: provenance.authorized_by,
          timestamp: provenance.timestamp,
          source: provenance.source,
        });
      });
    } finally {
      cleanup();
    }
  });

  it('rejects a stale revision on an existing-key artifact_register update without a write', () => {
    const { store, cleanup } = openStore();
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance });
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'g', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      const first = store.execute({
        operation: 'artifact_register',
        input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', content_hash: 'one', description: 'a' },
        expected_revision: 0,
        provenance,
      });
      const eventCount = store.listEvents({}).length;
      expect(() =>
        store.execute({
          operation: 'artifact_register',
          input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', content_hash: 'stale', description: 'a' },
          expected_revision: first.revision + 5,
          provenance,
        }),
      ).toThrow(/revision_conflict/);
      expect(store.listEvents({})).toHaveLength(eventCount);
    } finally {
      cleanup();
    }
  });

  // SPEC-007 Delivery Layer (Task I-3, ← AC-1.6): the two new mutations' event_type/payload-key
  // pairs are runtime-only allowlist entries (see the plan's compile-boundary note) — a green
  // build does not prove `INITIATIVE_EVENT_TYPES`/`INITIATIVE_EVENT_PAYLOAD_KEYS` were extended
  // correctly. Supplementary to the plan-authored deliverable-membership.contract.test.ts, which
  // already exercises the exact successful Event sequence end to end.
  it('emits the frozen event_type and exact payload keys for deliverable_define and deliverable_attach_artifact', () => {
    const { store, cleanup } = openStore();
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance });
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'g', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      const artifact = store.execute({
        operation: 'artifact_register',
        input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', description: 'a' },
        expected_revision: 0,
        provenance,
      });
      const beforeCount = store.listEvents({}).length;
      const deliverable = store.execute({
        operation: 'deliverable_define',
        input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' },
        expected_revision: 0,
        provenance,
      });
      store.execute({
        operation: 'deliverable_attach_artifact',
        input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement: 'executable_prototype' },
        expected_revision: deliverable.revision,
        provenance,
      });

      const events = store.listEvents({}).slice(beforeCount);
      expect(events.map((event) => event.event_type)).toEqual(['deliverable_defined', 'deliverable_artifact_attached']);
      expect(Object.keys(events[0]!.payload).sort()).toEqual(['delivery_contract', 'initiative_id', 'target_type', 'uuid'].sort());
      expect(Object.keys(events[1]!.payload).sort()).toEqual(['artifact_id', 'deliverable_id', 'requirement'].sort());
      expect(events[0]!.payload).toEqual({
        uuid: deliverable.uuid,
        initiative_id: initiative.uuid,
        target_type: 'runnable-prototype',
        delivery_contract: 'runnable-prototype@1',
      });
      expect(events[1]!.payload).toEqual({
        deliverable_id: deliverable.uuid,
        artifact_id: artifact.uuid,
        requirement: 'executable_prototype',
      });
    } finally {
      cleanup();
    }
  });

  it('rejects an attachment for a requirement not declared by the Delivery Contract without writing membership or an Event', () => {
    const { store, cleanup } = openStore();
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance });
      const initiative = store.execute({
        operation: 'initiative_create',
        input: { product_id: product.uuid, title: 'I', goal: 'g', status: 'open', outcome: null },
        expected_revision: 0,
        provenance,
      });
      const artifact = store.execute({
        operation: 'artifact_register',
        input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', description: 'a' },
        expected_revision: 0,
        provenance,
      });
      const deliverable = store.execute({
        operation: 'deliverable_define',
        input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' },
        expected_revision: 0,
        provenance,
      });
      const eventsBefore = store.listEvents({ initiative_id: initiative.uuid }).length;

      expect(() => store.execute({
        operation: 'deliverable_attach_artifact',
        input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement: 'not_a_contract_requirement' },
        expected_revision: deliverable.revision,
        provenance,
      })).toThrow(/requirement|invalid_request/i);

      expect(store.getDeliverable({ uuid: deliverable.uuid })).toMatchObject({ revision: deliverable.revision });
      expect(store.listEvents({ initiative_id: initiative.uuid })).toHaveLength(eventsBefore);
    } finally {
      cleanup();
    }
  });

  it('returns not_found for initiative_status against an unknown Initiative and writes nothing', () => {
    const { store, cleanup } = openStore();
    try {
      const eventCount = store.listEvents({}).length;
      expect(() =>
        store.execute({
          operation: 'initiative_status',
          input: { uuid: '00000000-0000-4000-8000-000000000099', status: 'closed', outcome: 'delivered' },
          expected_revision: 0,
          provenance,
        }),
      ).toThrow(/not_found/);
      expect(store.listEvents({})).toHaveLength(eventCount);
    } finally {
      cleanup();
    }
  });
});
