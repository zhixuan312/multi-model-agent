import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  INITIATIVE_EVENT_PAYLOAD_KEYS,
  INITIATIVE_OPERATIONS,
  INITIATIVE_SCHEMA_VERSION,
  InitiativeRecordStore,
  initiativeOperationRequestSchema,
  runInitiativeMigrations,
} from '../../packages/core/src/initiative-record/index.js';

const provenance = { actor_type: 'agent', actor_id: 'test', interface: 'test', initiated_by: 'test', authorized_by: 'test', timestamp: '2026-08-13T00:00:00.000Z', source: 'test' };
const IDS = ['software-change@1', 'research@1', 'solution-design@1', 'architecture-review@1', 'workflow-design@1', 'source-validation@1', 'risk-analysis@1', 'technical-writing@1', 'regulatory-assessment@1', 'intent-to-initiative@1'];

describe('Method registry contract and schema v6', () => {
  it('seeds only the frozen catalog and upgrades v4 Tasks without backfill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-method-v5-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const store = InitiativeRecordStore.open({ dbPath });
      const product = store.execute({ operation: 'product_create', input: { name: 'MMA', slug: 'method-v5' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      const task = store.execute({ operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, expected_revision: 0, provenance }) as { uuid: string; method: string | null };
      expect(task.method).toBeNull();
      store.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec('ALTER TABLE tasks DROP COLUMN method');
      raw.exec('DROP TABLE methods');
      raw.exec('PRAGMA user_version = 4');
      raw.close();
      runInitiativeMigrations({ dbPath });
      const upgraded = new DatabaseSync(dbPath);
      // SPEC-007 (Task I-1) added migration version 7 after this v4 database's target v6, so a
      // v4 database now upgrades through v5, v6, and v7, landing on the current
      // INITIATIVE_SCHEMA_VERSION rather than the v6 this check originally pinned. SPEC-007's
      // v7 tables are additive-only `CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE` DDL with
      // no v4/v5/v6 column dependency, so re-applying it here is inert for this check.
      expect(upgraded.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 });
      expect(upgraded.prepare('PRAGMA table_info(tasks)').all().map((row: { name: string }) => row.name)).toContain('method');
      expect(upgraded.prepare('SELECT id, is_builtin FROM methods ORDER BY id').all()).toEqual(IDS.slice().sort().map((id) => ({ id, is_builtin: 1 })));
      expect(upgraded.prepare('SELECT method FROM tasks WHERE uuid = ?').get(task.uuid)).toEqual({ method: null });
      upgraded.close();
      expect(INITIATIVE_SCHEMA_VERSION).toBe(7);
      expect(INITIATIVE_OPERATIONS).toEqual(expect.arrayContaining(['method_get', 'method_list', 'initiative_task_set_method']));
      expect(INITIATIVE_OPERATIONS.some((operation) => /method_(create|update|delete|register)/.test(operation))).toBe(false);
      expect(INITIATIVE_EVENT_PAYLOAD_KEYS.task_method_set).toEqual(['previous_method', 'new_method']);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'initiative_task_create', input: { initiative_id: initiative.uuid, title: 'T2', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [], method: 'software-change@1' }, expected_revision: 0, provenance }).success).toBe(true);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'method_register', input: {}, expected_revision: 0, provenance }).success).toBe(false);
      expect(initiativeOperationRequestSchema.safeParse({ operation: 'method_get', input: { id: 'software-change@1', extra: true } }).success).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});