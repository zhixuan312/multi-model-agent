import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, runInitiativeMigrations } from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'test', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' };

describe('Task claim schema migration', () => {
  it('adds only claimed_by at version 3 and maps legacy Task rows to null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-task-v3-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      let initiativeUuid = '';
      const seed = InitiativeRecordStore.open({ dbPath });
      try {
        const product = seed.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'mma' }, expected_revision: 0, provenance }) as { uuid: string };
        const initiative = seed.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
        initiativeUuid = initiative.uuid;
        seed.execute({ operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, expected_revision: 0, provenance });
      } finally { seed.close(); }
      const raw = new DatabaseSync(dbPath);
      raw.exec('ALTER TABLE tasks DROP COLUMN claimed_by');
      raw.exec('PRAGMA user_version = 2');
      raw.close();
      runInitiativeMigrations({ dbPath });
      const db = new DatabaseSync(dbPath);
      const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string; notnull: number }>;
      expect(columns.filter((column) => column.name === 'claimed_by').map(({ name, notnull }) => ({ name, notnull }))).toEqual([{ name: 'claimed_by', notnull: 0 }]);
      expect(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(3);
      db.close();
      const store = InitiativeRecordStore.open({ dbPath });
      try {
        expect(store.listInitiativeTasks({ initiative_id: initiativeUuid })).toEqual([expect.objectContaining({ claimed_by: null })]);
      } finally { store.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});