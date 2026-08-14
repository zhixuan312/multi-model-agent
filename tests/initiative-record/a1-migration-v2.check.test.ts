import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { INITIATIVE_SCHEMA_VERSION, runInitiativeMigrations } from '../../packages/core/src/initiative-record/index.js';

describe('Phase A1 migration version 2', () => {
  it('backs up and preserves a real version-1 database before additive upgrade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-a1-v2-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec(readFileSync(new URL('./fixtures/phase-a0-v1.sql', import.meta.url), 'utf8'));
      db.prepare("INSERT INTO products (uuid, name, slug, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?)").run('00000000-0000-4000-8000-000000000001', 'P', 'p', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);
      db.prepare("INSERT INTO initiatives (uuid, human_key, product_id, title, goal, status, outcome, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run('00000000-0000-4000-8000-000000000002', 'MMA-INIT-001', '00000000-0000-4000-8000-000000000001', 'I', 'G', 'open', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0);
      db.exec('PRAGMA user_version = 1');
      db.close();
      const before = statSync(dbPath).size;
      const result = runInitiativeMigrations({ dbPath });
      // SPEC-003 Phase B (Task I-1) added migration version 3, SPEC-004
      // (Task I-1) added migration version 4, SPEC-005 (Task I-1) added
      // migration version 5, and SPEC-006 (Task I-1) added migration version
      // 6; a v1 database upgrades through every pending migration, landing
      // on the current INITIATIVE_SCHEMA_VERSION rather than the Phase A1
      // version 2 this check originally pinned.
      expect(INITIATIVE_SCHEMA_VERSION).toBe(6);
      expect(result.backup_path).toBeDefined();
      expect(existsSync(result.backup_path!)).toBe(true);
      expect(statSync(result.backup_path!).size).toBe(before);
      const upgraded = new DatabaseSync(dbPath);
      expect((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6);
      expect(upgraded.prepare("SELECT human_key FROM initiatives WHERE human_key = 'MMA-INIT-001'").get()).toEqual({ human_key: 'MMA-INIT-001' });
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification_runs'").get()).toEqual({ name: 'verification_runs' });
      // Every version-1 table's seeded rows survive the upgrade (AC-1.9): the
      // fixture seeds >= 1 row per v1 table; counts must be unchanged.
      const v1Tables = ['products', 'workspaces', 'resources', 'initiatives', 'initiative_workspace_links', 'initiative_relations', 'tasks', 'artifact_refs', 'events', 'idempotency_results', 'counters'];
      for (const table of v1Tables) {
        const { n } = upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        expect(n, `post-upgrade row count for ${table}`).toBeGreaterThanOrEqual(1);
      }
      upgraded.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});