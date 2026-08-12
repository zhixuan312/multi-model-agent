/**
 * Initiative Record — schema DDL and the backup-before-upgrade migration runner
 * (Phase A0 kernel, Task I-2).
 *
 * `runInitiativeMigrations` is the sole writer of `<stateDir>/initiatives.db`'s
 * structure. It never touches `executions.db` (a different file, a different
 * store) and it never silently drops data: an existing database file is backed
 * up and the backup verified (existence + exact pre-change byte length) BEFORE
 * any versioned migration runs against it. A backup that cannot be produced or
 * verified fails the whole open with `migration_backup_failed` — schema
 * unchanged, original database intact.
 *
 * Table DDL uses `CREATE TABLE IF NOT EXISTS` and is itself one migration
 * (version 1) in an ordered list, so a later Phase A0 change appends a new
 * migration rather than editing this one (SPEC-001 "Implementation details").
 * Column names are stable snake_case internal storage; the public repository
 * layer (Task I-3/I-4) maps these to the frozen camelCase/snake_case public
 * shapes in `./types.js`. JSON-typed columns (`workspace_ids`, `resource_ids`,
 * `execution_refs`, `payload`, idempotency request hash + result) are stored
 * as TEXT.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MigrationBackupFailedError } from './errors.js';

/** The current installed schema version this build knows how to reach. */
export const INITIATIVE_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  apply: (db: DatabaseSync) => void;
}

/**
 * Version 1 — the complete Phase A0 schema: the nine stored record types
 * (Product, Workspace, Resource, Initiative, InitiativeWorkspaceLink,
 * InitiativeRelation, Task, ArtifactRef, Event), the idempotency-result table,
 * and the `counters` table backing monotonic per-installation allocation
 * (`MMA-INIT-<n>` human keys). Schema version itself lives in `PRAGMA
 * user_version` — no separate version table is needed.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
          uuid       TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          slug       TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspaces (
          uuid        TEXT PRIMARY KEY,
          product_id  TEXT NOT NULL REFERENCES products(uuid),
          name        TEXT NOT NULL,
          slug        TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          revision    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspaces_product_id ON workspaces(product_id);

        CREATE TABLE IF NOT EXISTS resources (
          uuid               TEXT PRIMARY KEY,
          workspace_id       TEXT NOT NULL REFERENCES workspaces(uuid),
          type               TEXT NOT NULL,
          canonical_locator  TEXT NOT NULL,
          local_path         TEXT,
          description        TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL,
          revision           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resources_workspace_id ON resources(workspace_id);

        CREATE TABLE IF NOT EXISTS initiatives (
          uuid       TEXT PRIMARY KEY,
          human_key  TEXT NOT NULL UNIQUE,
          product_id TEXT NOT NULL REFERENCES products(uuid),
          title      TEXT NOT NULL,
          goal       TEXT NOT NULL,
          status     TEXT NOT NULL,
          outcome    TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_initiatives_product_id ON initiatives(product_id);

        CREATE TABLE IF NOT EXISTS initiative_workspace_links (
          initiative_id TEXT NOT NULL REFERENCES initiatives(uuid),
          workspace_id  TEXT NOT NULL REFERENCES workspaces(uuid),
          role          TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          PRIMARY KEY (initiative_id, workspace_id, role)
        );

        CREATE TABLE IF NOT EXISTS initiative_relations (
          from_id    TEXT NOT NULL REFERENCES initiatives(uuid),
          to_id      TEXT NOT NULL REFERENCES initiatives(uuid),
          type       TEXT NOT NULL,
          created_at TEXT NOT NULL,
          revision   INTEGER NOT NULL,
          PRIMARY KEY (from_id, to_id, type)
        );
        CREATE INDEX IF NOT EXISTS idx_initiative_relations_to_id ON initiative_relations(to_id);

        CREATE TABLE IF NOT EXISTS tasks (
          uuid            TEXT PRIMARY KEY,
          initiative_id   TEXT NOT NULL REFERENCES initiatives(uuid),
          title           TEXT NOT NULL,
          goal            TEXT NOT NULL,
          status          TEXT NOT NULL,
          outcome         TEXT,
          workspace_ids   TEXT NOT NULL,
          resource_ids    TEXT NOT NULL,
          execution_refs  TEXT NOT NULL DEFAULT '[]',
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          revision        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_initiative_id ON tasks(initiative_id);

        CREATE TABLE IF NOT EXISTS artifact_refs (
          uuid              TEXT PRIMARY KEY,
          initiative_id     TEXT NOT NULL REFERENCES initiatives(uuid),
          storage_mode      TEXT NOT NULL,
          path_or_uri       TEXT NOT NULL,
          content_hash      TEXT,
          media_type        TEXT,
          version           TEXT,
          produced_by_task  TEXT,
          description       TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL,
          revision          INTEGER NOT NULL,
          UNIQUE (initiative_id, path_or_uri)
        );

        CREATE TABLE IF NOT EXISTS events (
          event_sequence INTEGER PRIMARY KEY,
          entity_type    TEXT NOT NULL,
          entity_id      TEXT NOT NULL,
          initiative_id  TEXT,
          event_type     TEXT NOT NULL,
          payload        TEXT NOT NULL,
          actor_type     TEXT NOT NULL,
          actor_id       TEXT NOT NULL,
          interface      TEXT NOT NULL,
          initiated_by   TEXT NOT NULL,
          authorized_by  TEXT NOT NULL,
          timestamp      TEXT NOT NULL,
          source         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_initiative_id ON events(initiative_id);

        CREATE TABLE IF NOT EXISTS idempotency_results (
          operation       TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash    TEXT NOT NULL,
          result_json     TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          PRIMARY KEY (operation, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS counters (
          name  TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO counters (name, value) VALUES ('initiative_human_key', 0);
      `);
    },
  },
];

export interface RunInitiativeMigrationsOptions {
  /** Absolute path to `initiatives.db`. Never `executions.db`. */
  dbPath: string;
  /**
   * Test seam: replaces the default backup copy (`fs.copyFileSync`). Production
   * never supplies this. Throwing here (or leaving no readable file at the
   * destination) fails the migration with `migration_backup_failed`.
   */
  copyBackup?: (sourcePath: string, destinationPath: string) => void;
}

export interface RunInitiativeMigrationsResult {
  /** Set only when an existing database file was backed up before upgrade; `null` on first creation. */
  backup_path: string | null;
  /** The installed schema version (`PRAGMA user_version`) after this call. */
  schema_version: number;
}

/**
 * Creates or upgrades `<stateDir>/initiatives.db` to {@link INITIATIVE_SCHEMA_VERSION}.
 *
 * First creation (no prior file at `dbPath`) never backs up — there is nothing
 * to protect. Every call against an already-existing file backs it up first,
 * verifies the backup (exists, exact pre-change byte length), and only then
 * opens a connection and applies the pending migrations. A backup failure
 * throws {@link MigrationBackupFailedError} before any schema change — the
 * original database is left untouched and no partial upgrade can occur.
 */
export function runInitiativeMigrations(opts: RunInitiativeMigrationsOptions): RunInitiativeMigrationsResult {
  const { dbPath } = opts;
  if (!isAbsolute(dbPath)) {
    throw new Error(`Initiative database path must be absolute: ${dbPath}`);
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  const existedBeforeOpen = existsSync(dbPath);
  let backupPath: string | null = null;

  if (existedBeforeOpen) {
    backupPath = `${dbPath}.bak-${randomUUID()}`;
    const copy = opts.copyBackup ?? defaultCopyBackup;
    let sourceSize: number;
    try {
      sourceSize = statSync(dbPath).size;
      copy(dbPath, backupPath);
      if (!existsSync(backupPath) || statSync(backupPath).size !== sourceSize) {
        throw new Error('backup is missing or differs from the pre-change byte length');
      }
    } catch (error) {
      throw new MigrationBackupFailedError({
        database_path: dbPath,
        backup_path: backupPath,
        message: `migration_backup_failed: backup of ${dbPath} at ${backupPath} could not be copied and verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    const currentVersion = readSchemaVersion(db);
    const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion).sort(
      (a, b) => a.version - b.version,
    );
    for (const migration of pending) {
      migration.apply(db);
      db.exec(`PRAGMA user_version = ${migration.version};`);
    }
    return { backup_path: backupPath, schema_version: readSchemaVersion(db) };
  } finally {
    db.close();
  }
}

function defaultCopyBackup(sourcePath: string, destinationPath: string): void {
  copyFileSync(sourcePath, destinationPath);
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = row?.user_version;
  const supportedVersions = new Set([0, ...MIGRATIONS.map((migration) => migration.version)]);
  if (!Number.isSafeInteger(version) || !supportedVersions.has(version)) {
    throw new Error(`invalid stored migration metadata: unsupported schema version ${String(version)}`);
  }
  return version;
}
