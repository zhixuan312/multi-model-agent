import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

const TABLES = ['products', 'workspaces', 'resources', 'initiatives', 'initiative_workspace_links', 'requirements', 'acceptance_criteria', 'events', 'idempotency_results'];
const STEPS = ['product', 'workspace', 'resource', 'initiative', 'initiative_workspace_link', 'requirement', 'acceptance_criterion'] as const;
const EXPECTED_EVENT_TYPES = ['product_created', 'workspace_created', 'resource_registered', 'initiative_created', 'initiative_workspace_linked', 'requirement_added', 'acceptance_criterion_added'].sort();
const provenance = { actor_type: 'human', actor_id: 'u1', interface: 'test', initiated_by: 'u1', authorized_by: 'u1', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };

function tableContent(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

function request() {
  return {
    operation: 'initiative_bootstrap', expected_revision: 0, idempotency_key: 'confirmed-intake', provenance,
    input: {
      product: { create: { name: 'New Product', slug: 'new-product' } },
      workspaces: [{ workspace_key: 'primary', role: 'creates', create: { name: 'New Workspace', slug: 'new-workspace', description: 'A future repository.' } }],
      resources: [{ workspace_key: 'primary', type: 'repository', canonical_locator: 'https://example.test/new-workspace', description: 'Future repository record.' }],
      initiative: { title: 'Confirmed intake', goal: 'Create the product outcome.', status: 'open', outcome: null },
      requirements: [{ statement: 'The outcome exists.', acceptance_criteria: [{ statement: 'The outcome is confirmed.', check_reference: 'manual confirmation' }] }],
    },
  };
}

describe('initiative_bootstrap transaction', () => {
  it.each(STEPS)('rolls back complete table content and Events when %s creation fails', (step) => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-bootstrap-atomic-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      const before = tableContent(dbPath);
      store.setBootstrapFailureStepForTest(step);
      expect(() => store.execute(request())).toThrow(/forced bootstrap failure/i);
      expect(tableContent(dbPath)).toEqual(before);
      expect(store.listEvents()).toEqual([]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates one Event per created entity with the caller provenance and the default lifecycle contract on a successful call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-bootstrap-success-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      const result = store.execute(request()) as {
        uuid: string;
        product: { uuid: string };
        workspaces: { workspace_key: string; uuid: string }[];
        resources: { uuid: string }[];
        initiative_workspace_links: { initiative_id: string; workspace_id: string; role: string }[];
        requirements: { uuid: string; acceptance_criteria: { uuid: string }[] }[];
      };
      expect(result.uuid).toEqual(expect.any(String));
      expect(result.product.uuid).toEqual(expect.any(String));
      expect(result.workspaces).toHaveLength(1);
      expect(result.resources).toHaveLength(1);
      expect(result.initiative_workspace_links).toEqual([
        expect.objectContaining({ initiative_id: result.uuid, workspace_id: result.workspaces[0].uuid, role: 'creates' }),
      ]);
      expect(result.requirements).toHaveLength(1);
      expect(result.requirements[0].acceptance_criteria).toHaveLength(1);
      const events = store.listEvents();
      expect(events.map((event) => event.event_type).sort()).toEqual(EXPECTED_EVENT_TYPES);
      for (const event of events) {
        expect(event.actor_type).toBe(provenance.actor_type);
        expect(event.actor_id).toBe(provenance.actor_id);
        expect(event.initiated_by).toBe(provenance.initiated_by);
        expect(event.authorized_by).toBe(provenance.authorized_by);
        expect(event.interface).toBe(provenance.interface);
        expect(event.timestamp).toBe(provenance.timestamp);
        expect(event.source).toBe(provenance.source);
      }
      const initiativeCreated = events.find((event) => event.event_type === 'initiative_created');
      expect((initiativeCreated?.payload as { uuid?: string } | undefined)?.uuid).toBe(result.uuid);
      const initiatives = tableContent(dbPath).initiatives as { uuid: string; lifecycle_contract: string }[];
      expect(initiatives.find((row) => row.uuid === result.uuid)?.lifecycle_contract).toBe('default-sdl@1');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a cross-Product existing Workspace before any table or Event changes and reports the real Initiative identifier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-bootstrap-cross-product-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      const productA = store.execute({ operation: 'product_create', input: { name: 'A', slug: 'a' }, expected_revision: 0, provenance }) as { uuid: string; revision: number };
      const productB = store.execute({ operation: 'product_create', input: { name: 'B', slug: 'b' }, expected_revision: 0, provenance }) as { uuid: string };
      const workspaceB = store.execute({ operation: 'workspace_create', input: { product_id: productB.uuid, name: 'B Workspace', slug: 'b-workspace', description: 'Wrong Product.' }, expected_revision: 0, provenance }) as { uuid: string };
      const before = tableContent(dbPath);
      let thrown: unknown;
      try {
        store.execute({
          operation: 'initiative_bootstrap', expected_revision: productA.revision, provenance,
          input: { product: { existing: { uuid: productA.uuid } }, workspaces: [{ workspace_key: 'wrong', role: 'references', existing: { uuid: workspaceB.uuid } }], resources: [], initiative: { title: 'Rejected', goal: 'Must not persist.', status: 'open', outcome: null } },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { message: string }).message).toMatch(/cross_product_workspace_link/);
      expect((thrown as { code?: string }).code).toBe('cross_product_workspace_link');
      expect((thrown as { initiative_id?: string }).initiative_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect((thrown as { workspace_id?: string }).workspace_id).toBe(workspaceB.uuid);
      expect(tableContent(dbPath)).toEqual(before);
      expect(store.listEvents()).toHaveLength(before.events.length);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});