// A migration and the `PRAGMA user_version` bump that records it must land as ONE unit.
//
// Without that, a failure partway through `apply()` leaves the schema half-changed while
// `user_version` still names the OLD version — so the next boot replays the same migration. Five
// of these statements are `ALTER TABLE ADD COLUMN`, which is not idempotent, so the replay fails
// on "duplicate column name" and keeps failing. The database is then permanently unopenable with
// no way forward but the backup file.
//
// Migration 4 is the discriminator because it begins with two sequential ALTERs:
//
//     ALTER TABLE initiatives ADD COLUMN focus_phase TEXT;        <- succeeds
//     ALTER TABLE initiatives ADD COLUMN lifecycle_contract TEXT; <- made to fail here
//
// Pre-adding only the SECOND column on a v3 database means the first statement applies and the
// second throws — exactly the half-applied shape. Without the transaction `focus_phase` survives
// the failure and the retry dies on it; with the transaction the whole migration rolls back and a
// retry succeeds once the conflict is removed.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInitiativeMigrations } from '../../packages/core/src/initiative-record/migrations.js';

describe('Initiative Record migrations are atomic with their version bump', () => {
  it('rolls a half-applied migration back rather than wedging the database on the next boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-migration-atomicity-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      // Bring the database to v3, then plant the conflict that makes migration 4 fail midway.
      runInitiativeMigrations({ dbPath });
      const raw = new DatabaseSync(dbPath);
      raw.exec('ALTER TABLE initiatives DROP COLUMN focus_phase');
      raw.exec('PRAGMA user_version = 3');
      raw.close();

      const planted = new DatabaseSync(dbPath);
      const columns = () =>
        (planted.prepare('PRAGMA table_info(initiatives)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns()).not.toContain('focus_phase');
      expect(columns()).toContain('lifecycle_contract'); // the planted conflict
      planted.close();

      // Migration 4 now throws on its second statement.
      expect(() => runInitiativeMigrations({ dbPath })).toThrow();

      // THE ASSERTION. `focus_phase` must NOT survive the failure: if it does, the retry replays
      // `ADD COLUMN focus_phase`, fails on "duplicate column name", and can never move forward.
      const after = new DatabaseSync(dbPath);
      const afterColumns = (after.prepare('PRAGMA table_info(initiatives)').all() as Array<{ name: string }>)
        .map((c) => c.name);
      const version = (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      after.close();
      expect(afterColumns).not.toContain('focus_phase');
      expect(version).toBe(3);

      // And the proof that it is recoverable rather than wedged: remove the planted conflict and
      // the same migration replays cleanly. (This fixture reached v3 by downgrading a fully
      // migrated database, so the artifacts LATER migrations add are still present and would
      // collide on their own replay — clear those too, so this step tests migration 4's recovery
      // and nothing else.)
      const fix = new DatabaseSync(dbPath);
      fix.exec('ALTER TABLE initiatives DROP COLUMN lifecycle_contract');
      fix.exec('ALTER TABLE tasks DROP COLUMN method');
      fix.exec(`DROP TABLE IF EXISTS deliverable_delivery_history;
                DROP TABLE IF EXISTS deliverable_artifacts;
                DROP TABLE IF EXISTS deliverables;
                DROP TABLE IF EXISTS delivery_contracts;
                DROP TABLE IF EXISTS methods;
                DROP TABLE IF EXISTS phase_records;
                DROP TABLE IF EXISTS lifecycle_contracts;`);
      fix.close();
      expect(() => runInitiativeMigrations({ dbPath })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
