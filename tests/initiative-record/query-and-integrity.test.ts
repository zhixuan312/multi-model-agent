import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'http', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-12T00:00:00.000Z', source: 'manual' };

describe('Initiative repository reads and integrity', () => {
  it('rejects a cross-Product link and writes no Event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-integrity-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const p1 = store.execute({ operation: 'product_create', input: { name: 'One', slug: 'one' }, expected_revision: 0, provenance }) as { uuid: string };
      const p2 = store.execute({ operation: 'product_create', input: { name: 'Two', slug: 'two' }, expected_revision: 0, provenance }) as { uuid: string };
      const w2 = store.execute({ operation: 'workspace_create', input: { product_id: p2.uuid, name: 'W2', slug: 'w2', description: 'd' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: p1.uuid, title: 'I', goal: 'g', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const eventCount = store.listEvents({}).length;
      expect(() => store.execute({ operation: 'initiative_link_workspace', input: { initiative_id: initiative.uuid, workspace_id: w2.uuid, role: 'references' }, expected_revision: 0, provenance })).toThrow(/cross_product_workspace_link/);
      expect(store.listEvents({})).toHaveLength(eventCount);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses the ArtifactRef composite key and exact frozen Event payload keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-artifact-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
      const workspace = store.execute({ operation: 'workspace_create', input: { product_id: product.uuid, name: 'Engine', slug: 'engine', description: 'd' }, expected_revision: 0, provenance }) as { uuid: string };
      const resource = store.execute({ operation: 'resource_register', input: { workspace_id: workspace.uuid, type: 'git_repository', canonical_locator: 'repo', description: 'd' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'g', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string; human_key: string };
      expect(store.getInitiative({ uuid: initiative.uuid })).toEqual(store.getInitiative({ human_key: initiative.human_key }));
      const related = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'Related', goal: 'g', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      store.execute({ operation: 'initiative_link_workspace', input: { initiative_id: initiative.uuid, workspace_id: workspace.uuid, role: 'references' }, expected_revision: 0, provenance });
      store.execute({ operation: 'initiative_relate', input: { from_id: initiative.uuid, to_id: related.uuid, type: 'related_to' }, expected_revision: 0, provenance });
      store.execute({ operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'Task', goal: 'g', status: 'open', outcome: null, workspace_ids: [workspace.uuid], resource_ids: [resource.uuid] }, expected_revision: 0, provenance });
      const first = store.execute({ operation: 'artifact_register', input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', content_hash: 'one', description: 'a' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      const second = store.execute({ operation: 'artifact_register', input: { initiative_id: initiative.uuid, storage_mode: 'external', path_or_uri: '/a.md', content_hash: 'two', description: 'a' }, expected_revision: first.revision, provenance }) as { uuid: string; revision: number };
      expect(second.uuid).toBe(first.uuid);
      expect(second.revision).toBe(first.revision + 1);
      const events = store.listEvents({});
      expect(events.map((event) => event.event_type)).toEqual(['product_created', 'workspace_created', 'resource_registered', 'initiative_created', 'initiative_created', 'initiative_workspace_linked', 'initiative_related', 'task_created', 'artifact_registered', 'artifact_updated']);
      expect(Object.keys(events.at(-1)!.payload).sort()).toEqual(['content_hash', 'initiative_id', 'path_or_uri', 'uuid']);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});