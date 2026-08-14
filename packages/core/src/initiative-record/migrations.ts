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
import { DEFAULT_LIFECYCLE_CONTRACT_ID, type LifecycleContract, type MethodDeclaration } from './types.js';

/** The current installed schema version this build knows how to reach. */
export const INITIATIVE_SCHEMA_VERSION = 6;

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
  {
    // Version 2 — Phase A1 professional record and verification ledger
    // (SPEC-002, "Data model" and "Implementation details"). Additive only: no
    // version 1 table or column is reshaped, renamed, or dropped. Every new
    // table below is either identified by its own UUID or, for EvidenceLink,
    // by its composite `(evidence_id, target_type, target_id)` identity — the
    // sole Phase A1 record with no UUID primary key. Human-key allocation
    // (`REQ-<n>`, `AC-<n>`, `D-<n>`, `RISK-<n>`) reuses the existing generic
    // `counters(name, value)` table from version 1 at a scoped key (for
    // example `requirement_human_key:<initiative_id>`); no new counter table
    // is needed. The public repository layer (Task I-3/I-4/I-5) maps these
    // snake_case columns to the frozen public shapes in `./types.js`.
    version: 2,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS requirements (
          uuid          TEXT PRIMARY KEY,
          initiative_id TEXT NOT NULL REFERENCES initiatives(uuid),
          human_key     TEXT NOT NULL,
          statement     TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          UNIQUE (initiative_id, human_key)
        );
        CREATE INDEX IF NOT EXISTS idx_requirements_initiative_id ON requirements(initiative_id);

        CREATE TABLE IF NOT EXISTS acceptance_criteria (
          uuid            TEXT PRIMARY KEY,
          requirement_id  TEXT NOT NULL REFERENCES requirements(uuid),
          human_key       TEXT NOT NULL,
          statement       TEXT NOT NULL,
          check_reference TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          revision        INTEGER NOT NULL,
          UNIQUE (requirement_id, human_key)
        );
        CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_requirement_id ON acceptance_criteria(requirement_id);

        CREATE TABLE IF NOT EXISTS decisions (
          uuid           TEXT PRIMARY KEY,
          initiative_id  TEXT NOT NULL REFERENCES initiatives(uuid),
          human_key      TEXT NOT NULL,
          title          TEXT NOT NULL,
          decision       TEXT NOT NULL,
          rationale      TEXT NOT NULL,
          alternatives   TEXT NOT NULL,
          status         TEXT NOT NULL,
          superseded_by  TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          revision       INTEGER NOT NULL,
          UNIQUE (initiative_id, human_key)
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_initiative_id ON decisions(initiative_id);

        CREATE TABLE IF NOT EXISTS evidence (
          uuid          TEXT PRIMARY KEY,
          initiative_id TEXT NOT NULL REFERENCES initiatives(uuid),
          kind          TEXT NOT NULL,
          locator       TEXT NOT NULL,
          content_hash  TEXT,
          summary       TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          UNIQUE (initiative_id, locator)
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_initiative_id ON evidence(initiative_id);

        CREATE TABLE IF NOT EXISTS evidence_links (
          evidence_id  TEXT NOT NULL REFERENCES evidence(uuid),
          target_type  TEXT NOT NULL,
          target_id    TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          revision     INTEGER NOT NULL,
          PRIMARY KEY (evidence_id, target_type, target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_links_target ON evidence_links(target_type, target_id);

        CREATE TABLE IF NOT EXISTS risks (
          uuid          TEXT PRIMARY KEY,
          initiative_id TEXT NOT NULL REFERENCES initiatives(uuid),
          human_key     TEXT NOT NULL,
          statement     TEXT NOT NULL,
          severity      TEXT NOT NULL,
          status        TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          UNIQUE (initiative_id, human_key)
        );
        CREATE INDEX IF NOT EXISTS idx_risks_initiative_id ON risks(initiative_id);

        CREATE TABLE IF NOT EXISTS verification_runs (
          uuid                     TEXT PRIMARY KEY,
          initiative_id            TEXT NOT NULL REFERENCES initiatives(uuid),
          acceptance_criterion_id  TEXT NOT NULL REFERENCES acceptance_criteria(uuid),
          method                   TEXT NOT NULL,
          state                    TEXT NOT NULL,
          detail                   TEXT NOT NULL,
          created_at               TEXT NOT NULL,
          revision                 INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_verification_runs_acceptance_criterion_id ON verification_runs(acceptance_criterion_id);
        CREATE INDEX IF NOT EXISTS idx_verification_runs_initiative_id ON verification_runs(initiative_id);
      `);
    },
  },
  {
    // Version 3 — SPEC-003 Phase B Task claim data contract ("Data model",
    // Task I-1). Additive only: the sole change is a nullable `claimed_by`
    // column on the existing `tasks` table (no v1/v2 table, index, or column
    // is reshaped, renamed, or dropped, and no other Initiative-record schema
    // change is in scope). SQLite's `ALTER TABLE ... ADD COLUMN` with no
    // `NOT NULL` clause and no explicit default backfills every existing row
    // with `NULL`, which the public repository layer maps to `claimed_by: null`.
    version: 3,
    apply: (db) => {
      db.exec(`ALTER TABLE tasks ADD COLUMN claimed_by TEXT;`);
    },
  },
  {
    // Version 4 — SPEC-004 Lifecycle Engine data contract ("Data model", Task I-1). Additive
    // only: nullable `initiatives.focus_phase`/`initiatives.lifecycle_contract` columns, the new
    // `phase_records` and `lifecycle_contracts` tables, and one seeded immutable
    // `default-sdl@1` row carrying the pinned six-phase definition. No v1/v2/v3 table, index, or
    // column is reshaped, renamed, or dropped, and this migration inserts NO `phase_records`
    // rows for any existing Initiative — every lifecycle read overlays six synthesized
    // `not_started` defaults on top of whatever rows exist (Task I-4), never backfilling.
    version: 4,
    apply: (db) => {
      db.exec(`
        ALTER TABLE initiatives ADD COLUMN focus_phase TEXT;
        ALTER TABLE initiatives ADD COLUMN lifecycle_contract TEXT;

        CREATE TABLE IF NOT EXISTS phase_records (
          initiative_id TEXT NOT NULL REFERENCES initiatives(uuid),
          phase         TEXT NOT NULL,
          state         TEXT NOT NULL,
          PRIMARY KEY (initiative_id, phase)
        );

        CREATE TABLE IF NOT EXISTS lifecycle_contracts (
          id              TEXT PRIMARY KEY,
          definition_json TEXT NOT NULL,
          is_builtin      INTEGER NOT NULL
        );
      `);
      db.prepare(`INSERT OR IGNORE INTO lifecycle_contracts (id, definition_json, is_builtin) VALUES (?, ?, 1)`).run(
        DEFAULT_SDL_CONTRACT.id,
        JSON.stringify(DEFAULT_SDL_CONTRACT),
      );
    },
  },
  {
    // Version 5 — SPEC-005 Method Registry data contract ("Data model", Task I-1). Additive
    // only: a nullable `tasks.method` column and the new `methods` table (frozen catalog,
    // immutable — no update or delete path exists anywhere in this codebase). No v1-v4 table,
    // index, or column is reshaped, renamed, or dropped, and this migration does NOT backfill
    // `tasks.method` for any existing Task — every Task created before this migration, and
    // every new Task that omits `method`, reads `method: null` until a caller explicitly sets
    // one (Task I-3). `INSERT OR IGNORE` seeds exactly the nine frozen version-1 declarations
    // pinned by SPEC-005 "Data model"; it makes a repeat migration run idempotent (there is no
    // caller write path that could otherwise conflict).
    version: 5,
    apply: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN method TEXT;

        CREATE TABLE IF NOT EXISTS methods (
          id              TEXT PRIMARY KEY,
          definition_json TEXT NOT NULL,
          is_builtin      INTEGER NOT NULL
        );
      `);
      const insert = db.prepare(`INSERT OR IGNORE INTO methods (id, definition_json, is_builtin) VALUES (?, ?, 1)`);
      for (const method of BUILTIN_METHODS) {
        insert.run(method.id, JSON.stringify(method));
      }
    },
  },
  {
    // Version 6 — SPEC-006 Business intake Method catalog addition ("Data model", Task I-1).
    // Additive only: seeds the tenth built-in Method declaration, `intent-to-initiative@1`, into
    // the existing `methods` table created by migration v5. No new table, column, or index. The
    // nine version-5 declarations (`BUILTIN_METHODS` above) are untouched by this migration —
    // they remain byte-for-byte equivalent in their declared fields — and this is a SEPARATE
    // seed, not an addition to that array, so a brand-new database still reaches the tenth
    // identifier through its own dedicated migration step rather than folding into v5's seed.
    // `INSERT OR IGNORE` makes a repeat migration run idempotent.
    version: 6,
    apply: (db) => {
      db.prepare(`INSERT OR IGNORE INTO methods (id, definition_json, is_builtin) VALUES (?, ?, 1)`).run(
        INTENT_TO_INITIATIVE_METHOD.id,
        JSON.stringify(INTENT_TO_INITIATIVE_METHOD),
      );
    },
  },
];

/**
 * The frozen, seeded built-in Method catalog (SPEC-005 "Data model" — the pinned table).
 * Exactly these nine version-1 declarations exist; there is no caller-visible registration
 * path. Procedure prose lives in the committed `packages/core/src/methods/<name>/guidance.md`
 * assets (Task I-2), never in this declaration.
 */
const BUILTIN_METHODS: readonly MethodDeclaration[] = [
  {
    id: 'software-change@1',
    name: 'Software change',
    version: 1,
    purpose: 'Change software safely to satisfy a defined need.',
    required_inputs: ['source code', 'requested behavior', 'acceptance criteria'],
    expected_outputs: ['changed source code', 'test evidence'],
    verification_expectations: [
      'caller tracing',
      'error-path review',
      'security-sink review',
      'schema conformance',
      'test adequacy',
    ],
  },
  {
    id: 'research@1',
    name: 'Research',
    version: 1,
    purpose: 'Produce an evidence-based answer to a focused question.',
    required_inputs: ['research question', 'source constraints'],
    expected_outputs: ['findings', 'sources', 'limitations'],
    verification_expectations: ['source relevance', 'claim support', 'limitation disclosure'],
  },
  {
    id: 'solution-design@1',
    name: 'Solution design',
    version: 1,
    purpose: 'Define a workable solution for a stated problem.',
    required_inputs: ['problem statement', 'goals', 'constraints'],
    expected_outputs: ['solution design', 'decision rationale', 'acceptance criteria'],
    verification_expectations: ['goal coverage', 'constraint fit', 'decision traceability'],
  },
  {
    id: 'architecture-review@1',
    name: 'Architecture review',
    version: 1,
    purpose: 'Assess a system structure against required qualities and constraints.',
    required_inputs: ['architecture description', 'quality goals', 'constraints'],
    expected_outputs: ['review findings', 'risks', 'recommendations'],
    verification_expectations: ['evidence-backed findings', 'trade-off analysis', 'scope coverage'],
  },
  {
    id: 'workflow-design@1',
    name: 'Workflow design',
    version: 1,
    purpose: 'Define an operational workflow that produces a required outcome.',
    required_inputs: ['desired outcome', 'actors', 'constraints'],
    expected_outputs: ['workflow definition', 'roles', 'control points'],
    verification_expectations: ['step completeness', 'role clarity', 'failure handling'],
  },
  {
    id: 'source-validation@1',
    name: 'Source validation',
    version: 1,
    purpose: 'Assess whether a source is suitable for a stated use.',
    required_inputs: ['source', 'intended use', 'validation criteria'],
    expected_outputs: ['validation result', 'evidence', 'limitations'],
    verification_expectations: ['provenance', 'relevance', 'currency', 'integrity'],
  },
  {
    id: 'risk-analysis@1',
    name: 'Risk analysis',
    version: 1,
    purpose: 'Identify and assess risks to a defined outcome.',
    required_inputs: ['scope', 'objectives', 'available evidence'],
    expected_outputs: ['risk register', 'likelihood', 'impact', 'mitigations'],
    verification_expectations: ['risk coverage', 'evidence basis', 'mitigation ownership'],
  },
  {
    id: 'technical-writing@1',
    name: 'Technical writing',
    version: 1,
    purpose: 'Produce clear technical content for a defined audience.',
    required_inputs: ['subject matter', 'audience', 'required format'],
    expected_outputs: ['technical document', 'source references'],
    verification_expectations: ['accuracy', 'audience fit', 'structural completeness'],
  },
  {
    id: 'regulatory-assessment@1',
    name: 'Regulatory assessment',
    version: 1,
    purpose: 'Assess stated facts against identified regulatory requirements.',
    required_inputs: ['applicable requirements', 'facts', 'jurisdiction'],
    expected_outputs: ['assessment', 'evidence', 'limitations'],
    verification_expectations: ['requirement coverage', 'source currency', 'professional sign-off when required'],
  },
];

/**
 * The tenth built-in Method declaration (SPEC-006 "Data model" — Task I-1). Seeded by migration
 * v6, kept separate from {@link BUILTIN_METHODS} so the nine version-5 declarations are never
 * touched by this addition. Procedure prose lives in the committed
 * `packages/core/src/methods/intent-to-initiative/guidance.md` asset, never in this declaration.
 */
const INTENT_TO_INITIATIVE_METHOD: MethodDeclaration = {
  id: 'intent-to-initiative@1',
  name: 'Intent to initiative',
  version: 1,
  purpose: 'Turn a stated business goal into a confirmed Initiative Record draft without creating any record entity before confirmation.',
  required_inputs: ['business goal', 'stakeholder context'],
  expected_outputs: ['confirmed draft', 'human confirmation'],
  verification_expectations: [
    'goal elicitation',
    'necessary-question discipline',
    'draft completeness',
    'human confirmation',
    'record-entity restraint',
  ],
};

/**
 * The frozen `default-sdl@1` definition (SPEC-004 "Data model" — the pinned YAML). Seeded once
 * by migration v4 as an immutable, built-in row; `execute` deliberately has no Requirement or
 * Acceptance Criterion Establishment because SPEC-007's Delivery Contract validation, not this
 * specification, owns Execute-phase gating.
 */
const DEFAULT_SDL_CONTRACT: LifecycleContract = {
  id: DEFAULT_LIFECYCLE_CONTRACT_ID,
  phases: {
    discover: { required: [{ key: 'problem_framed', satisfier: 'manual' }] },
    refine: {
      required: [
        { key: 'scoped_goal', satisfier: 'manual' },
        { key: 'requirements_defined', satisfier: 'requirements_exist' },
        { key: 'acceptance_criteria_defined', satisfier: 'acceptance_criteria_exist' },
      ],
    },
    design: {
      required: [
        { key: 'design_artifact', satisfier: 'manual' },
        { key: 'key_decisions_settled', satisfier: 'decisions_settled' },
      ],
    },
    execute: { required: [] },
    verify: { required: [{ key: 'acceptance_verified', satisfier: 'manual' }] },
    deliver: { required: [{ key: 'delivery_confirmed', satisfier: 'manual' }] },
  },
};

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
 * to protect. An existing file is backed up ONLY when at least one migration is
 * pending (an up-to-date database opens with no backup, so routine opens do not
 * grow the state directory). Before the copy, the WAL is checkpointed
 * (`PRAGMA wal_checkpoint(TRUNCATE)`) so committed data still sitting in the
 * `-wal` sidecar after an unclean shutdown is folded into the main file the
 * backup copies. The backup is then verified (exists, exact pre-change byte
 * length) before any schema change. A backup failure throws
 * {@link MigrationBackupFailedError} before any schema change — the original
 * database is left untouched and no partial upgrade can occur.
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
    // Read the installed version and checkpoint the WAL on a short-lived
    // connection BEFORE deciding on (and taking) a backup.
    let currentVersion: number;
    const inspect = new DatabaseSync(dbPath);
    try {
      inspect.exec('PRAGMA busy_timeout = 5000;');
      currentVersion = readSchemaVersion(inspect);
      inspect.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      inspect.close();
    }

    const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion);
    if (pending.length > 0) {
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
  if (version === undefined || !Number.isSafeInteger(version) || !supportedVersions.has(version)) {
    throw new Error(`invalid stored migration metadata: unsupported schema version ${String(version)}`);
  }
  return version;
}
