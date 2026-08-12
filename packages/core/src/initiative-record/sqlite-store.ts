/**
 * Initiative Record — the SQLite-backed store (Phase A0 kernel).
 *
 * Task I-2 scope: own the single dedicated `DatabaseSync` connection over
 * `<stateDir>/initiatives.db` (WAL mode, non-zero busy timeout — the same
 * verified pattern as `packages/server/src/application/execution-store.ts`),
 * apply the versioned schema through {@link runInitiativeMigrations} on open,
 * and expose the lifecycle + inspection surface
 * `tests/initiative-record/migration-and-store.test.ts` checks against.
 *
 * `execute()` (the transactional write algorithm — Task I-3) and the read
 * methods (Task I-4) are added on top of this same connection in later tasks;
 * this class is deliberately the one place that owns `db` so those tasks
 * extend it rather than opening a second connection to the same file.
 */
import { DatabaseSync } from 'node:sqlite';
import { runInitiativeMigrations } from './migrations.js';

export interface InitiativeRecordStorePragmas {
  journal_mode: string;
  busy_timeout: number;
}

export class InitiativeRecordStore {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Opens (creating or migrating) the dedicated Initiative database at
   * `dbPath`. Never opens, modifies, or attaches `executions.db` — the caller
   * supplies `join(expandHome(config.server.stateDir), 'initiatives.db')`.
   */
  static open(opts: { dbPath: string }): InitiativeRecordStore {
    runInitiativeMigrations({ dbPath: opts.dbPath });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(opts.dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      return new InitiativeRecordStore(db);
    } catch (error) {
      // Guard against a leaked native handle if a PRAGMA throws after `new
      // DatabaseSync` already assigned a live handle — nothing else holds a
      // reference to close it otherwise.
      if (db) {
        try {
          db.close();
        } catch {
          // already closed / never fully opened — nothing more to release.
        }
      }
      throw error;
    }
  }

  /** Test/inspection use: this store connection's own pragma settings. */
  inspectPragmas(): InitiativeRecordStorePragmas {
    const journalRow = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    const busyRow = this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    return {
      journal_mode: String(journalRow?.journal_mode ?? ''),
      busy_timeout: Number(busyRow?.timeout ?? 0),
    };
  }

  /** Test/inspection use: table and view names currently present in the schema. */
  listSchemaTables(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
      .all() as Array<{ name?: string }>;
    return rows.map((row) => String(row.name));
  }

  /** Closes the store's own `DatabaseSync` connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
