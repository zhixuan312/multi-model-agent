import { existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, runInitiativeMigrations } from '../../packages/core/src/initiative-record/index.js';

describe('InitiativeRecordStore migrations', () => {
  it('creates a dedicated WAL database with a positive busy timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-store-'));
    const dbPath = join(dir, 'initiatives.db');
    const store = InitiativeRecordStore.open({ dbPath });
    try {
      expect(existsSync(dbPath)).toBe(true);
      // Connection pragmas come from the STORE: `busy_timeout` is per-connection and a second
      // connection cannot see it, so this is the one thing only the store can answer.
      expect(store.inspectPragmas()).toMatchObject({ journal_mode: 'wal', busy_timeout: expect.any(Number) });
      expect(store.inspectPragmas().busy_timeout).toBeGreaterThan(0);
      // Schema shape is a property of the FILE, so read it through an ordinary connection rather
      // than through a test-only method on the production class.
      const probe = new DatabaseSync(dbPath);
      try {
        const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>)
          .map((row) => row.name);
        expect(tables).toEqual(expect.arrayContaining(['products', 'initiatives', 'events', 'idempotency_results']));
      } finally { probe.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('backs up an existing database before upgrade and refuses an unverified backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-initiative-migration-'));
    const dbPath = join(dir, 'initiatives.db');
    mkdirSync(dir, { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA user_version = 0');
    legacy.close();
    const before = statSync(dbPath).size;
    const result = runInitiativeMigrations({ dbPath });
    expect(result.backup_path).toBeDefined();
    expect(existsSync(result.backup_path!)).toBe(true);
    expect(statSync(result.backup_path!).size).toBe(before);
    const blockedPath = join(dir, 'blocked.db');
    const blocked = new DatabaseSync(blockedPath);
    blocked.exec('PRAGMA user_version = 0');
    blocked.close();
    expect(() => runInitiativeMigrations({ dbPath: blockedPath, copyBackup: () => { throw new Error('copy blocked'); } })).toThrow(/migration_backup_failed/);
    rmSync(dir, { recursive: true, force: true });
  });
});