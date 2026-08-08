import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { detectGitChanges } from './freshness.js';
import type { FreshnessDecision } from './freshness.js';
import { rrfSearch } from './search.js';
import type {
  CorpusAdapter,
  IndexHealth,
  LexicalHit,
  StoredRecord,
  StoredRecordMeta,
} from './types.js';

/** Default throttle for the non-git full stat-sweep fallback: at most once every 5 minutes per open index. */
const DEFAULT_FALLBACK_SWEEP_INTERVAL_MS = 5 * 60_000;




/**
 * Corpus-neutral derived SQLite index.
 *
 * This engine stores and ranks generic "records" supplied by a `CorpusAdapter`
 * (see `./types.ts`). Domain semantics belong to the adapter. The engine only
 * knows: enumerate the adapter's files, decode each into a
 * record, keep an SQLite + FTS5 cache of those records in sync with their
 * source files, and rank a candidate pool by fusing lexical search with
 * whatever extra ranked signal lists the adapter supplies.
 *
 * The adapter's source files are the single source of truth; this index is
 * fully rebuildable from them at any time.
 */

export const CORPUS_INDEX_SCHEMA_VERSION = 3;
export const CORPUS_INDEX_DB_FILENAME = 'index.db';

const REQUIRED_TABLES = ['records', 'records_fts'];
/**
 * Fanout multiplier for {@link CorpusIndex.narrowedMatchPattern}'s
 * rarest-tokens-first prefix: tokens are kept while their SUMMED un-scoped
 * match counts stay at or below `limit x NARROW_FANOUT_MARGIN`. Keeping this
 * at one bounds the FTS rows that must be ranked before the SQL `LIMIT` to the
 * same candidate cap the rest of retrieval uses.
 */
const NARROW_FANOUT_MARGIN = 1;

/**
 * Tables owned by the deleted pre-engine journal store
 * (`packages/core/src/journal/index-store.ts`, removed in Task I-5). A
 * database file carrying any of these is explicitly stale, independent of
 * `PRAGMA user_version`: an old build could have stamped the version to the
 * current value before this check existed, or a future bump could reintroduce
 * the same trap this list forecloses. Their presence alone forces a rebuild.
 */
const LEGACY_TABLES = ['vectors_meta', 'documents', 'documents_fts'];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}



function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Decode one `records` row into a {@link StoredRecord} or {@link
 * StoredRecordMeta} (`includeBody` selects which), shared by every read path
 * that selects the same column set (`allRecords`, `allRecordsMeta`,
 * `recordsByIds`, `recordsMetaByIds`, `candidateRecordsMeta`) so the mapping
 * is written once.
 */
function toStoredRecord(row: Record<string, unknown>, includeBody: boolean): StoredRecord | StoredRecordMeta {
  const base = {
    id: asString(row.id),
    path: asString(row.path),
    title: asString(row.title),
    mtimeMs: asNumber(row.mtime_ms),
    contentHash: asString(row.content_hash),
    topic: asString(row.topic),
    status: asString(row.status),
    adapterMeta: row.adapter_meta == null ? undefined : asString(row.adapter_meta),
  };
  return includeBody ? { ...base, body: asString(row.body) } : base;
}


/**
 * Process-wide, root-keyed non-git fallback-sweep throttle state (see
 * {@link CorpusIndex.ensureFreshSymbols}). A caller that opens a NEW
 * `CorpusIndex` per request (e.g. the investigate preprocessor, which
 * open()s → uses → close()s the index every call) must pass the SAME
 * `FallbackSweepState` object across those calls — an instance keeping this
 * state purely in its own private fields would reset it (and so lose the
 * throttle entirely) on every request.
 */
export interface FallbackSweepState {
  lastFallbackSweepAt: number | null;
  fallbackSweepCount: number;
}

export class CorpusIndex {
  static async open(opts: {
    root: string;
    adapter: CorpusAdapter;
    /**
     * Optional override for where the derived SQLite file itself lives.
     * Absent (the default) — identical to today's behavior: the database sits
     * at `<root>/index.db`, alongside the corpus it derives from. The journal
     * index (`JournalCorpusAdapter`, via `JournalIndexStore`) relies on this
     * default and must keep it: its database stays at `.mma/journal/index.db`.
     * Present — the corpus root is walked/read exactly as normal, but the
     * derived database is written to this path instead. Used by the
     * repository code-corpus index (the investigate preprocessor) so a
     * derived cache never lands inside a source tree the caller does not own.
     */
    dbPath?: string;
    /**
     * Throttle interval, in milliseconds, for the non-git full stat-sweep
     * freshness fallback (see {@link ensureFresh}). Ignored on the git path,
     * which never sweeps. Defaults to {@link DEFAULT_FALLBACK_SWEEP_INTERVAL_MS}.
     */
    fallbackSweepIntervalMs?: number;
    /**
     * Shared throttle state for the non-git fallback sweep (see
     * {@link FallbackSweepState}). Omit for a fresh, instance-local state
     * (fine for a long-lived `CorpusIndex`); pass a shared object when the
     * caller opens a new `CorpusIndex` per call against the same root, so the
     * throttle actually applies across calls.
     */
    sweepState?: FallbackSweepState;
    /**
     * Open the database WITHOUT write access.
     *
     * A read-only route's worker runs inside an OS sandbox (codex uses
     * `-s read-only`) that denies writes outside its cwd. SQLite opens
     * read-write by default and creates `-wal`/`-shm` sidecars next to the
     * database, so a normal open fails there with "attempt to write a
     * readonly database" even when the caller only intends to read.
     *
     * With this set the connection is read-only and the schema bootstrap is
     * skipped. The caller MUST NOT then call `ensureHealthy()` or
     * `ensureFresh()` — both write. That is the correct division anyway: the
     * daemon's preprocessor refreshes the index before the worker starts, so
     * a worker only ever needs to read what is already current.
     */
    readOnly?: boolean;
    /**
     * SQLite journal mode for a read-write open. Defaults to `wal`.
     *
     * Pass `delete` for an index that sandboxed readers must open read-only.
     * WAL keeps a `-shm` sidecar that SQLite needs WRITE access to map, even
     * for a reader — and it deletes that sidecar when the last connection
     * closes. So a WAL index is unreadable from a read-only sandbox after the
     * writer disconnects. `delete` mode leaves a self-contained file that a
     * read-only connection can open with no write access at all.
     *
     * The trade-off is concurrency: `delete` blocks readers during a write.
     * That is the right trade for the code index, which has ONE writer (the
     * daemon's preprocessor, briefly, only when files changed) and MANY
     * readers (workers). The journal index keeps `wal`.
     */
    journalMode?: 'wal' | 'delete';
  }): Promise<CorpusIndex> {
    const index = new CorpusIndex(
      opts.root,
      opts.adapter,
      opts.fallbackSweepIntervalMs ?? DEFAULT_FALLBACK_SWEEP_INTERVAL_MS,
      opts.sweepState ?? { lastFallbackSweepAt: null, fallbackSweepCount: 0 },
      opts.dbPath,
      opts.readOnly === true,
      opts.journalMode ?? 'wal',
    );
    // First-use bootstrap: `new DatabaseSync(<dbPath>)` throws
    // ENOENT/SQLITE_CANTOPEN when its parent dir does not exist yet — true of
    // both the default (`<root>/index.db`) and a caller-supplied override.
    // A read-only open must not create anything, including the parent dir.
    if (!opts.readOnly) await mkdir(dirname(index.dbPath), { recursive: true });
    index.openDatabase();
    return index;
  }

  private db!: DatabaseSync;
  private freshnessDecision: FreshnessDecision | null = null;
  /**
   * The `CorpusAdapter.rootMtimeMs()` value observed on the last {@link
   * ensureFreshRecords} check that actually ran `listFiles()` — `null`
   * before any check has run. Used to skip that O(corpus) enumeration when
   * the root's mtime is unchanged.
   */
  private lastKnownRootMtimeMs: number | null = null;

  /**
   * Cached prepared statements for the `records`/`records_fts` read path
   * (the `CorpusAdapter` storage mode's hot per-query operations), so a
   * query prepares each of these exactly once per store rather than once per
   * call. Cleared by {@link invalidateRecordStatements} whenever
   * `records`/`records_fts` is dropped and recreated — a statement prepared
   * against the OLD table object must not be reused once the table has been
   * dropped, even though the replacement carries the same name.
   */
  private allRecordsStmt?: StatementSync;
  private allRecordsMetaStmt?: StatementSync;
  private lexicalSearchStmt?: StatementSync;
  private recordCountStmt?: StatementSync;
  /** Cached by `IN` placeholder count for targeted post-ranking body reads. */
  private readonly recordsByIdsStmts = new Map<number, StatementSync>();
  /**
   * Cached by `IN` placeholder count for targeted metadata-only reads (no
   * `body`) — used for bounded graph-neighbour target lookups
   * ({@link recordsMetaByIds}), never for a whole-corpus read.
   */
  private readonly recordsMetaByIdsStmts = new Map<number, StatementSync>();
  /**
   * Cached candidate-query statements ({@link candidateRecordsMeta}), keyed
   * by `<hasTopic>:<includeHistory>` — at most four variants (topic
   * present/absent x history included/excluded).
   */
  private readonly candidateStmts = new Map<string, StatementSync>();
  /**
   * Cached un-scoped `count(*)` statement backing {@link unscopedMatchCount}/
   * {@link narrowedMatchPattern} — a single statement (no topic/status
   * variants; it never joins to `records`).
   */
  private candidateCountStmt?: StatementSync;


  private constructor(
    private readonly root: string,
    private readonly adapter: CorpusAdapter,
    private readonly fallbackSweepIntervalMs: number,
    private readonly sweepState: FallbackSweepState,
    private readonly dbPathOverride: string | undefined,
    private readonly readOnly: boolean = false,
    private readonly journalMode: 'wal' | 'delete' = 'wal',
  ) {}

  private get dbPath(): string {
    return this.dbPathOverride ?? join(this.root, CORPUS_INDEX_DB_FILENAME);
  }

  private openDatabase(): void {
    // Guard against a leaked native SQLite handle: `new DatabaseSync(...)`
    // assigns a LIVE handle on its first line, and the PRAGMAs / schema
    // bootstrap that follow can still throw (e.g. SQLITE_BUSY under
    // contention). Without this try/catch, `CorpusIndex.open()` propagates
    // that throw with the half-built instance already discarded — unclosed —
    // and nothing left holding a reference to `db` ever calls `.close()` on
    // it. A caller that retries `open()` (e.g. the investigate preprocessor's
    // bounded retry) can leak one handle per attempt.
    let db: DatabaseSync | undefined;
    try {
      if (this.readOnly) {
        // No WAL pragma and no schema bootstrap: both write. `busy_timeout`
        // is safe and still useful while the daemon refreshes concurrently.
        db = new DatabaseSync(this.dbPath, { readOnly: true });
        this.db = db;
        db.exec('PRAGMA busy_timeout = 5000;');
      } else {
        db = new DatabaseSync(this.dbPath);
        this.db = db;
        db.exec(`PRAGMA journal_mode = ${this.journalMode === 'delete' ? 'DELETE' : 'WAL'};`);
        db.exec('PRAGMA busy_timeout = 5000;');
        db.exec('PRAGMA foreign_keys = ON;');
        this.bootstrapSchema();
      }
    } catch (error) {
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

  /**
   * Bootstrap the schema ONLY on a genuinely fresh database file (no known
   * table of either storage mode exists yet). An EXISTING database — even one
   * on an outdated schema version — is left untouched here: {@link ensureSchema}
   * runs `CREATE TABLE IF NOT EXISTS`, a no-op against an already-existing
   * table that would silently skip a newly added column (e.g. `adapter_meta`),
   * and then unconditionally stamps `PRAGMA user_version` to the CURRENT
   * version — which would make {@link schemaIsValid} / {@link fileSymbolTablesValid}
   * report that stale table as valid forever, so an outdated on-disk database
   * would never actually rebuild. Every caller runs {@link ensureHealthy}
   * before reading or writing, which detects a genuine version/table mismatch
   * and performs a full drop + recreate rebuild instead.
   */
  private bootstrapSchema(): void {
    let tables: string[];
    try {
      tables = this.tableNames();
    } catch {
      tables = [];
    }
    // ANY existing table — known-current, unrecognized, or an explicitly
    // legacy one such as `vectors_meta` — means this database file is not
    // genuinely fresh. Bootstrapping only ever runs `CREATE TABLE IF NOT
    // EXISTS` and then unconditionally stamps the CURRENT `user_version`; if
    // it ran against a database that still carries the pre-engine
    // `documents`/`vectors_meta` tables, it would create `records`/
    // `records_fts` alongside them and stamp the version to current BEFORE
    // {@link ensureHealthy} ever runs — making the legacy tables look valid
    // forever. Defer entirely to {@link ensureHealthy} (and its explicit
    // legacy-table check in {@link schemaIsValid} / {@link fileSymbolTablesValid})
    // whenever any table already exists.
    if (tables.length > 0) return;
    this.ensureSchema();
  }

  /**
   * Create the tables this corpus needs: `records` plus its `records_fts`
   * full-text index, one record per source file.
   */
  private ensureSchema(): void {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          id           TEXT PRIMARY KEY,
          path         TEXT NOT NULL,
          title        TEXT NOT NULL,
          body         TEXT NOT NULL,
          mtime_ms     REAL NOT NULL,
          content_hash TEXT NOT NULL,
          topic        TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL DEFAULT '',
          adapter_meta TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          tokenize = 'porter unicode61'
        );
        CREATE INDEX IF NOT EXISTS idx_records_topic ON records(topic);
        CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
    `);
    this.db.exec(`PRAGMA user_version = ${CORPUS_INDEX_SCHEMA_VERSION};`);
  }

  private tableNames(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => asString(row.name));
  }

  private schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
    return asNumber(row?.user_version);
  }

  /**
   * True when every required table exists, no legacy pre-engine table is
   * present, and the schema version matches. Table absence/presence is
   * checked explicitly and BEFORE relying on `user_version` at all: a legacy
   * database can carry a `user_version` that already equals the current
   * constant (an old build stamped it, or the constant was bumped without a
   * corresponding structural check), so the version comparison alone can
   * never be trusted to detect a stale schema.
   */
  private schemaIsValid(): boolean {
    let tables: string[];
    try {
      tables = this.tableNames();
    } catch {
      return false;
    }
    if (LEGACY_TABLES.some((name) => tables.includes(name))) return false;
    if (!REQUIRED_TABLES.every((name) => tables.includes(name))) return false;
    if (!this.recordsFacetColumnsPresent()) return false;
    return this.schemaVersion() === CORPUS_INDEX_SCHEMA_VERSION;
  }

  /**
   * True when the `records` table itself carries the indexed `topic`/`status`
   * facet columns this schema version requires. An explicit STRUCTURAL check,
   * independent of `user_version` — the same defense {@link LEGACY_TABLES}
   * provides for a table that was dropped, applied here for a table whose
   * COLUMN SET changed instead ({@link CORPUS_INDEX_SCHEMA_VERSION} 2 -> 3,
   * `topic`/`status` promoted out of `adapter_meta` into real columns).
   * `ensureSchema` only ever stamps `PRAGMA user_version` — it never runs
   * `ALTER TABLE` against an existing table — so a database file left over
   * from schema version 2 has a `records` table with NO `topic`/`status`
   * columns at all; comparing `user_version` alone would already correctly
   * force a rebuild on THIS specific bump (2 -> 3 is a version this codebase
   * never wrote before), but a structural check that does not depend on
   * every prior build's version-stamping discipline having been perfect is
   * cheap here and closes that class of trap for good.
   */
  private recordsFacetColumnsPresent(): boolean {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(records)`).all() as Array<Record<string, unknown>>;
      const columns = new Set(rows.map((row) => asString(row.name)));
      return columns.has('topic') && columns.has('status');
    } catch {
      return false;
    }
  }

  /**
   * Open + required-table + schema-version check. If the derived cache is
   * missing tables or on the wrong schema version, drop and rebuild it from
   * the authoritative source files. Freshness (new/changed files) is the job
   * of {@link syncIncremental}, not this method.
   */
  async ensureHealthy(): Promise<IndexHealth> {
    const valid = this.schemaIsValid();
    if (valid) return { state: 'ready' };
    await this.rebuild();
    return { state: 'rebuilt' };
  }

  /**
   * Indexed record count — a single cheap `SELECT count(*)`.
   *
   * Public because adapters need a freshness comparison that does NOT load the
   * corpus. A derived index loses its value when the freshness check costs more
   * than the read it protects.
   */
  recordCount(): number {
    if (!this.recordCountStmt) {
      this.recordCountStmt = this.db.prepare('SELECT count(*) AS n FROM records');
    }
    const row = this.recordCountStmt.get() as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  /**
   * Indexed `files` row count for the `files`/`symbols` storage mode — the
   * symbol-mode counterpart to {@link recordCount}. Used by
   * {@link ensureFreshSymbols} to detect a schema-valid but still-EMPTY index
   * (nothing yet to diff against) without loading the corpus.
   */
  /**
   * Cheap per-query freshness gate.
   *
   * The corpus root's mtime is checked first, which is a single `stat`. Only
   * when that mtime changed does this method pay the O(corpus) `listFiles()`
   * enumeration, so the overwhelming majority of queries skip it entirely.
   *
   * `CorpusAdapter` corpora (journal) keep their existing cheap count
   * comparison: compare the adapter's current file COUNT to the indexed
   * record count and only run the full incremental sync when they differ
   * (add/remove drift) or the schema is invalid. Same-count out-of-band
   * content edits are NOT detected here — those are the job of an explicit
   * {@link rebuild} / {@link syncIncremental}. When the adapter supplies
   * {@link CorpusAdapter.rootMtimeMs}, that count comparison itself is
   * pre-gated by a single cheap `stat` (see {@link ensureFreshRecords}):
   * `listFiles()` — an O(corpus) directory enumeration — only runs when the
   * root's mtime has actually changed since the last check, which is the
   * common case for the overwhelming majority of queries.
   */
  async ensureFresh(): Promise<void> {
    if (!this.schemaIsValid()) {
      await this.rebuild();
      return;
    }
    await this.ensureFreshRecords(this.adapter);
  }

  /**
   * The `CorpusAdapter` (records) half of {@link ensureFresh}. Pre-gated by
   * the adapter's optional {@link CorpusAdapter.rootMtimeMs}: when supplied
   * and UNCHANGED since the last check, this skips `listFiles()` (an
   * O(corpus) directory enumeration) entirely — nothing could have been
   * added or removed if the directory's own mtime never moved. When absent,
   * or when the mtime DID change, falls through to the exact same
   * `listFiles().length !== recordCount()` comparison this always ran.
   */
  private async ensureFreshRecords(adapter: CorpusAdapter): Promise<void> {
    if (adapter.rootMtimeMs) {
      const currentMtimeMs = await adapter.rootMtimeMs();
      if (currentMtimeMs !== null && currentMtimeMs === this.lastKnownRootMtimeMs) return;
      const files = await adapter.listFiles();
      if (files.length !== this.recordCount()) await this.syncIncremental();
      this.lastKnownRootMtimeMs = currentMtimeMs;
      return;
    }
    const files = await adapter.listFiles();
    if (files.length !== this.recordCount()) {
      await this.syncIncremental();
    }
  }

  /**
   * The freshness decision {@link ensureFresh} took on its most recent call —
   * `null` before `ensureFresh()` has ever run. Exposed for diagnostics and
   * tests; never itself triggers work.
   */
  lastFreshnessDecision(): FreshnessDecision | null {
    return this.freshnessDecision;
  }

  /**
   * Targeted symbol-table sync for an EXACT set of changed/deleted paths —
   * the git path's counterpart to {@link syncSymbolsIncremental}. Unlike that
   * method, this never enumerates or stats the whole corpus: it reads and
   * re-parses only the paths git already told us changed, and deletes rows
   * only for the paths git already told us are gone. Whole-file replace,
   * same as every other symbol write path: an edit shifts every symbol's
   * line range below it, so per-symbol change detection is never attempted.
   */
  /**
   * Delete-then-upsert one BATCH of prepared `files`/`symbols` rows inside
   * its own short transaction. Shared by {@link rebuildSymbols}, {@link
   * syncSymbolsIncremental} (via {@link applySymbolSyncPlans}), and {@link
   * syncSymbolPaths}. A delete against a non-existent row is a no-op, so this
   * is also a valid write for a freshly (re)created table.
   */
  /** Delete every `files`/`symbols`/`symbols_trgm` row for the given paths inside one short transaction. */
  /**
   * Migration cleanup only — never schema creation. Drops every table owned
   * by the deleted pre-engine journal store, if present. A fresh or already-
   * current database has none of these and the statements are no-ops.
   */
  private dropLegacyTables(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS vectors_meta;
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS documents;
    `);
  }

  /**
   * Drop every cached prepared statement bound to `records`/`records_fts`.
   * Must run before those tables are dropped: a statement prepared against
   * the table object being dropped must be re-`prepare()`d against its
   * replacement, not reused.
   */
  private invalidateRecordStatements(): void {
    this.allRecordsStmt = undefined;
    this.allRecordsMetaStmt = undefined;
    this.lexicalSearchStmt = undefined;
    this.recordCountStmt = undefined;
    this.recordsByIdsStmts.clear();
    this.recordsMetaByIdsStmts.clear();
    this.candidateStmts.clear();
    this.candidateCountStmt = undefined;
  }

  /**
   * Drop every cached prepared statement bound to `files`/`symbols`. Must run
   * before those tables are dropped — same reasoning as
   * {@link invalidateRecordStatements}, for the symbol-mode statements.
   */
  private dropAndRecreateSchema(): void {
    this.invalidateRecordStatements();
    this.db.exec(`
      DROP TABLE IF EXISTS records;
      DROP TABLE IF EXISTS records_fts;
    `);
    this.dropLegacyTables();
    this.ensureSchema();
  }

  /**
   * Full rebuild: recreate the schema and re-derive every row from the
   * adapter's source files, into `records`/`records_fts` (one record per file).
   */
  async rebuild(): Promise<void> {
    const adapter = this.adapter;
    this.dropAndRecreateSchema();
    const files = await adapter.listFiles();
    const insertRecord = this.db.prepare(
      `INSERT INTO records (id, path, title, body, mtime_ms, content_hash, topic, status, adapter_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(`INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const relPath of files) {
        // Tolerate a single unreadable/undecodable EXISTING file: skip-and-warn
        // so one malformed source file can't crash the whole index rebuild.
        let loaded: StoredRecord;
        try {
          loaded = await this.loadFile(adapter, relPath);
        } catch (error) {
          console.warn(
            `[corpus-engine:${adapter.corpusId}] skipping unreadable/undecodable record ${relPath}: ${(error as Error).message}`,
          );
          continue;
        }
        insertRecord.run(
          loaded.id,
          loaded.path,
          loaded.title,
          loaded.body,
          loaded.mtimeMs,
          loaded.contentHash,
          loaded.topic ?? '',
          loaded.status ?? '',
          loaded.adapterMeta ?? null,
        );
        insertFts.run(loaded.id, loaded.title, loaded.body);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Full rebuild for the `files`/`symbols` storage mode: for every adapter
   * file, read once, extract its symbols once, and insert the fresh set.
   * Unreadable files are warned-and-skipped, exactly like the records mode.
   *
   * Processed in BOUNDED BATCHES (see {@link SYMBOL_SYNC_BATCH_SIZE}): each
   * batch is read/hashed/extracted entirely OUTSIDE any transaction (async
   * I/O/CPU work; running it while a `BEGIN` transaction is open would hold
   * SQLite's writer lock for the whole rebuild, starving any concurrent
   * writer's bounded `SQLITE_BUSY` retries), then written inside its own
   * short transaction before the next batch starts. Holding every file's
   * extracted symbol bodies for the WHOLE corpus in memory at once — the
   * pre-batching behavior — can exhaust the heap on a large repository.
   */
  /**
   * Read, hash, and extract symbols for each of `relPaths`, entirely outside
   * any transaction. Unreadable/undecodable files are warned-and-skipped
   * rather than aborting the whole batch.
   */
  /**
   * Immediately before a batch's write transaction, re-`stat` each prepared
   * file and compare its mtime against what was captured during preparation.
   * Preparation (read/hash/extract) runs entirely outside any transaction and
   * can take arbitrarily long; if a file changed — and was possibly committed
   * — DURING that window, writing the stale snapshot would mean a
   * subsequently clean `git status` never triggers a refresh, and the stale
   * row stays wrong forever. Re-prepare just the drifted files so the batch
   * commits their CURRENT content instead.
   */
  /**
   * Incremental sync keyed by source path + mtime + content hash. Only files
   * whose mtime AND content hash differ from the stored row are re-decoded and
   * upserted; files that vanished are dropped. Cheap enough to run before
   * every retrieval.
   */
  async syncIncremental(): Promise<void> {
    const adapter = this.adapter;
    if (!this.schemaIsValid()) {
      await this.rebuild();
      return;
    }
    const existing = new Map<string, { id: string; mtimeMs: number; contentHash: string }>();
    const rows = this.db
      .prepare('SELECT id, path, mtime_ms, content_hash FROM records')
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      existing.set(asString(row.path), {
        id: asString(row.id),
        mtimeMs: asNumber(row.mtime_ms),
        contentHash: asString(row.content_hash),
      });
    }

    const files = await adapter.listFiles();
    const seenPaths = new Set<string>();

    this.db.exec('BEGIN');
    try {
      for (const relPath of files) {
        seenPaths.add(relPath);
        const fullPath = join(this.root, relPath);
        const st = await stat(fullPath);
        const prior = existing.get(relPath);
        if (prior && prior.mtimeMs === st.mtimeMs) continue; // unchanged by mtime

        const raw = await readFile(fullPath, 'utf8');
        const contentHash = createHash('sha256').update(raw).digest('hex');
        if (prior && prior.contentHash === contentHash) {
          // Content identical, only mtime drifted — refresh mtime, skip re-decode.
          this.db.prepare('UPDATE records SET mtime_ms = ? WHERE path = ?').run(st.mtimeMs, relPath);
          continue;
        }
        // Tolerate a single unreadable/undecodable EXISTING file: skip-and-warn
        // so one malformed source file can't crash the incremental sync.
        let loaded: StoredRecord;
        try {
          const record = await adapter.decode(relPath, raw);
          loaded = { ...record, mtimeMs: st.mtimeMs, contentHash };
        } catch (error) {
          console.warn(
            `[corpus-engine:${adapter.corpusId}] skipping unreadable/undecodable record ${relPath}: ${(error as Error).message}`,
          );
          continue;
        }
        // A record whose id changed for the same path (rare) leaves behind a
        // stale row under the old id — delete it explicitly before upserting.
        if (prior && prior.id !== loaded.id) this.deleteRecord(prior.id);
        this.upsertRecord(loaded);
      }

      // Drop rows whose file disappeared.
      const currentRows = this.db.prepare('SELECT id, path FROM records').all() as Array<Record<string, unknown>>;
      for (const row of currentRows) {
        const path = asString(row.path);
        if (!seenPaths.has(path)) this.deleteRecord(asString(row.id));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Incremental sync for the `files`/`symbols` storage mode, keyed by
   * `file_path` + mtime + content hash. A file is UNCHANGED only when both
   * mtime and content hash match its stored `files` row; per-symbol change
   * detection is never attempted, because a single-line edit shifts every
   * symbol's line range below it. On a genuine content change: delete every
   * `symbols` row for that exact `file_path`, upsert its `files` row, parse
   * once, and insert the fresh symbol set — all inside one transaction, so a
   * reader never observes a half-replaced file's symbols.
   */
  /** Apply one batch of {@link SymbolSyncPlan}s inside its own short transaction. */
  private upsertRecord(loaded: StoredRecord): void {
    this.db
      .prepare(
        `INSERT INTO records (id, path, title, body, mtime_ms, content_hash, topic, status, adapter_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           title = excluded.title,
           body = excluded.body,
           mtime_ms = excluded.mtime_ms,
           content_hash = excluded.content_hash,
           topic = excluded.topic,
           status = excluded.status,
           adapter_meta = excluded.adapter_meta`,
      )
      .run(
        loaded.id,
        loaded.path,
        loaded.title,
        loaded.body,
        loaded.mtimeMs,
        loaded.contentHash,
        loaded.topic ?? '',
        loaded.status ?? '',
        loaded.adapterMeta ?? null,
      );
    this.db.prepare('DELETE FROM records_fts WHERE id = ?').run(loaded.id);
    this.db.prepare('INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)').run(loaded.id, loaded.title, loaded.body);
  }

  private deleteRecord(id: string): void {
    this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM records_fts WHERE id = ?').run(id);
  }

  private async loadFile(adapter: CorpusAdapter, relPath: string): Promise<StoredRecord> {
    const fullPath = join(this.root, relPath);
    const raw = await readFile(fullPath, 'utf8');
    const st = await stat(fullPath);
    const contentHash = createHash('sha256').update(raw).digest('hex');
    const record = await adapter.decode(relPath, raw);
    return { ...record, mtimeMs: st.mtimeMs, contentHash };
  }

  /**
   * Every `symbols` row for one exact `file_path` (the `files`/`symbols`
   * storage mode), ordered by source position. Empty array for a file with
   * no indexed symbols (including when the corpus was never indexed).
   */
  /**
   * Every `symbols` row across the WHOLE corpus (the `files`/`symbols`
   * storage mode), unordered. {@link symbolsForFile} answers "what does this
   * one known file contain"; this answers "what does the corpus contain" —
   * the shape a corpus-wide candidate search (e.g. the investigate
   * preprocessor) needs and no per-file lookup can serve.
   */
  /**
   * Every `files` row (the `files`/`symbols` storage mode) — per-file
   * change-detection metadata (path, mtime, content hash) only, never
   * content. Used alongside {@link allSymbols} to build a folder-level map
   * of the whole corpus without enumerating every file's content.
   */
  /**
   * Every `symbols` row's metadata ONLY — id/path/name/kind/line-range, never
   * `body` (the `files`/`symbols` storage mode's counterpart to
   * {@link allRecordsMeta}). Ranking a symbol corpus (candidate scoring, the
   * folder-level map the investigate preprocessor builds) needs none of a
   * symbol's body text; only a caller that will actually return a symbol's
   * text should pay to project it (see {@link symbolsByIds}). Same row set as
   * {@link allSymbols}, just a cheaper column list.
   */
  /**
   * For one already-lowercased query token, the ids of every symbol whose
   * `name` matches (case-insensitive substring) and, separately, whose `body`
   * matches — resolved entirely in SQL via `LIKE`, so a caller can score a
   * whole corpus against many tokens without ever reading `name`/`body` text
   * itself back into this process. A symbol whose name AND body both match
   * appears in both lists. `token` may contain `_` (a valid identifier
   * character that is also `LIKE`'s single-character wildcard); see
   * {@link escapeLikeLiteral}.
   *
   * Weighting a match (e.g. "name match counts more than a body match") is a
   * caller/adapter-owned scoring decision, not the engine's — this returns
   * raw match membership only, mirroring how {@link CorpusAdapter.signals}
   * keeps domain scoring out of the corpus-neutral engine.
   */
  /**
   * Produces the FTS-backed candidate ids for a ranked symbol query. For
   * multi-token searches, a rarity-first prefix caps the FTS fanout at the
   * requested result limit. Tokens with no matching rows are excluded before
   * prefix selection so they cannot consume the guaranteed first slot.
   */
  /**
   * The highest-scoring symbols for the supplied unique query tokens, with
   * FTS candidate selection, ranking, cap, and metadata projection all
   * performed by SQLite. The body column is used only inside `LIKE`
   * predicates; it is never projected. A caller that needs bodies for these
   * winners must fetch them separately via {@link symbolsByIds}.
   *
   * The score exactly mirrors investigate's historical JS calculation: every
   * token contributes 3 for a name substring match and 1 for a body substring
   * match. `tokenize` produces ASCII tokens, matching SQLite `LIKE`'s default
   * case-insensitive semantics for those tokens.
   *
   * `symbols_trgm` supplies the candidate ids before the score expression is
   * evaluated. The final `LIMIT` remains in this statement, and only metadata
   * (never symbol bodies) is materialized for the surviving winners.
   */
  /**
   * Folder-level file and symbol counts for the whole indexed corpus. SQLite
   * does the aggregation so callers don't have to materialize every file or
   * symbol merely to build a compact folder map.
   */
  /** Every derived-index row, decoded back into structured form. */
  allRecords(): StoredRecord[] {
    if (!this.allRecordsStmt) {
      this.allRecordsStmt = this.db.prepare(
        'SELECT id, path, title, body, mtime_ms, content_hash, topic, status, adapter_meta FROM records',
      );
    }
    const rows = this.allRecordsStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => toStoredRecord(row, true) as StoredRecord);
  }

  /**
   * Every derived-index row's metadata ONLY — id/path/title/mtime/hash/
   * topic/status/adapter-meta, never `body`. Ranking (lexical fusion, tag
   * overlap, graph-neighbour expansion) needs none of a record's body text;
   * only a caller that will actually return a record's text should pay to
   * project it (see {@link recordsByIds}). Same row set as {@link
   * allRecords}, just a cheaper column list. This is still a WHOLE-CORPUS
   * read — callers on the per-query candidate path should use {@link
   * candidateRecordsMeta} instead, which is SQL-bounded; this remains for
   * callers that genuinely need every record (e.g. the reindex CLI's node
   * count).
   */
  allRecordsMeta(): StoredRecordMeta[] {
    if (!this.allRecordsMetaStmt) {
      this.allRecordsMetaStmt = this.db.prepare(
        'SELECT id, path, title, mtime_ms, content_hash, topic, status, adapter_meta FROM records',
      );
    }
    const rows = this.allRecordsMetaStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => toStoredRecord(row, false) as StoredRecordMeta);
  }

  /**
   * Full records (including `body`) for exactly the given ids — the targeted
   * lookup a caller runs once to materialize text for the records it has
   * already decided, via {@link allRecordsMeta} + ranking, that it will
   * actually return. Unmatched ids are silently omitted. Empty `ids`
   * short-circuits without touching the database. Not cached as a prepared
   * statement: the `IN (...)` placeholder count varies per call, and this
   * runs once against a small, already-narrowed id set — not per corpus row.
   */
  recordsByIds(ids: string[]): StoredRecord[] {
    if (ids.length === 0) return [];
    let stmt = this.recordsByIdsStmts.get(ids.length);
    if (!stmt) {
      const placeholders = ids.map(() => '?').join(', ');
      stmt = this.db.prepare(
        `SELECT id, path, title, body, mtime_ms, content_hash, topic, status, adapter_meta FROM records WHERE id IN (${placeholders})`,
      );
      this.recordsByIdsStmts.set(ids.length, stmt);
    }
    const rows = stmt.all(...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => toStoredRecord(row, true) as StoredRecord);
  }

  /**
   * Metadata-only records (no `body`) for exactly the given ids — the
   * `recordsByIds` counterpart used for BOUNDED graph-neighbour target
   * lookups: a handful of specific link targets a candidate pool's seed
   * documents point to, never a whole-corpus read. Cached by `IN` placeholder
   * count, same reasoning as {@link recordsByIds}. Empty `ids` short-circuits
   * without touching the database.
   */
  recordsMetaByIds(ids: string[]): StoredRecordMeta[] {
    if (ids.length === 0) return [];
    let stmt = this.recordsMetaByIdsStmts.get(ids.length);
    if (!stmt) {
      const placeholders = ids.map(() => '?').join(', ');
      stmt = this.db.prepare(
        `SELECT id, path, title, mtime_ms, content_hash, topic, status, adapter_meta FROM records WHERE id IN (${placeholders})`,
      );
      this.recordsMetaByIdsStmts.set(ids.length, stmt);
    }
    const rows = stmt.all(...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => toStoredRecord(row, false) as StoredRecordMeta);
  }

  /**
   * SQL-BOUNDED candidate query: lexical FTS5/BM25 match, joined against
   * `records` and scoped by an optional exact `topic` equality and
   * `status != 'superseded'` visibility — both against the real, indexed
   * columns added in schema version 3 (see {@link ensureSchema}) — capped at
   * `limit` rows and returned in bm25 order (best match first). This is the
   * query that replaces reading the whole corpus (or a whole topic) into JS
   * and filtering there: every predicate that can run in SQL does, and the
   * row COUNT returned is bounded by `limit`, never by corpus or topic size.
   *
   * Empty `tokens` short-circuits without touching the database: an empty
   * FTS5 MATCH pattern cannot express "match nothing", and every ranking
   * signal this engine fuses for a query (lexical, tag overlap, and
   * neighbour expansion seeded from lexical/tag) is driven off `tokens` — no
   * tokens can never win any signal regardless of what the candidate pool
   * contains, so there is nothing a query against the database could add.
   */
  candidateRecordsMeta(opts: { tokens: string[]; topic?: string; includeHistory: boolean; limit: number }): StoredRecordMeta[] {
    const clean = opts.tokens.map((token) => token.replace(/"/g, '').trim()).filter((token) => token.length > 0);
    if (clean.length === 0) return [];
    const key = `${opts.topic !== undefined ? 1 : 0}:${opts.includeHistory ? 1 : 0}`;
    const match = this.narrowedMatchPattern(clean, opts.limit);
    const stmt = this.candidateSelectStmt(key, opts.topic !== undefined, opts.includeHistory);
    const bindings: Array<string | number> = [match];
    if (opts.topic !== undefined) bindings.push(opts.topic);
    bindings.push(opts.limit);
    const rows = stmt.all(...bindings) as Array<Record<string, unknown>>;
    return rows.map((row) => toStoredRecord(row, false) as StoredRecordMeta);
  }

  private candidateSelectStmt(key: string, hasTopic: boolean, includeHistory: boolean): StatementSync {
    let stmt = this.candidateStmts.get(key);
    if (!stmt) {
      const topicClause = hasTopic ? 'AND r.topic = ?' : '';
      const statusClause = includeHistory ? '' : `AND r.status != 'superseded'`;
      stmt = this.db.prepare(
        `SELECT r.id, r.path, r.title, r.mtime_ms, r.content_hash, r.topic, r.status, r.adapter_meta
         FROM records r
         JOIN records_fts f ON f.id = r.id
         WHERE f.records_fts MATCH ? ${topicClause} ${statusClause}
         ORDER BY bm25(f.records_fts)
         LIMIT ?`,
      );
      this.candidateStmts.set(key, stmt);
    }
    return stmt;
  }

  /**
   * Un-scoped (no topic/status join) document count for one FTS5 MATCH
   * pattern — a cheap, bounded posting-list-length lookup FTS5 answers from
   * its own term statistics without materializing a single row or joining to
   * `records`. Used only to RANK tokens by rarity in {@link
   * narrowedMatchPattern}; a topic/status-SCOPED count would need the same
   * per-row join {@link candidateSelectStmt} does, which is exactly the cost
   * narrowing exists to avoid paying more than once.
   */
  private unscopedMatchCount(pattern: string): number {
    if (!this.candidateCountStmt) {
      this.candidateCountStmt = this.db.prepare(`SELECT count(*) AS n FROM records_fts WHERE records_fts MATCH ?`);
    }
    const row = this.candidateCountStmt.get(pattern) as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  /**
   * Reorder `tokens` rarest-document-frequency-first, then OR-join a PREFIX
   * of them — the query's actual MATCH pattern — stopping once the prefix's
   * SUMMED individual match counts (an upper bound on their true union: union
   * size <= sum of sizes) exceeds `limit x NARROW_FANOUT_MARGIN`. This exists
   * because `ORDER BY bm25(...)` (needed for a genuinely best-first result)
   * forces SQLite to fully materialize AND sort every MATCHing row before
   * applying `LIMIT` — cheap when the match set is small, but proportional to
   * corpus size when a query's tokens include common words that appear in a
   * large, roughly-constant FRACTION of the corpus (their match count grows
   * with corpus size, not with how many documents are actually relevant).
   * Narrowing the pattern down to its rarest tokens first keeps the match set
   * — and so the sort — bounded regardless of corpus size, while never
   * dropping the rarest (most discriminating) tokens a query has.
   *
   * Ranking is by UN-SCOPED count ({@link unscopedMatchCount}, no topic/status
   * join) rather than the topic-scoped count the final query will actually
   * see: a topic-scoped count is itself only answerable by the same per-row
   * join {@link candidateSelectStmt} pays for, which would reintroduce
   * per-token O(matches) work — exactly what narrowing exists to avoid. Using
   * the un-scoped count as a rarity PROXY is safe: the topic-scoped result is
   * always a subset of the un-scoped one, so a token rare un-scoped is at
   * least as rare within any one topic, and `NARROW_FANOUT_MARGIN` leaves
   * headroom for a topic's share of common tokens to still clear `limit`
   * matches once genuinely scoped.
   *
   * Skipped entirely (returns the full OR of every token) when there is at
   * most one token, or the full pattern's UN-SCOPED count is already at or
   * below `limit`: a topic-scoped count can only be smaller, so sorting that
   * few rows is cheap and narrowing would only add cost for no benefit.
   */
  private narrowedMatchPattern(tokens: string[], limit: number): string {
    const fullPattern = tokens.map((token) => `"${token}"`).join(' OR ');
    if (tokens.length <= 1) return fullPattern;
    if (this.unscopedMatchCount(fullPattern) <= limit) return fullPattern;

    const byRarity = tokens
      .map((token) => ({ token, n: this.unscopedMatchCount(`"${token}"`) }))
      .sort((a, b) => a.n - b.n);

    const ceiling = limit * NARROW_FANOUT_MARGIN;
    let sum = 0;
    const kept: string[] = [];
    for (const { token, n } of byRarity) {
      if (kept.length > 0 && sum + n > ceiling) break;
      sum += n;
      kept.push(token);
    }
    return kept.map((token) => `"${token}"`).join(' OR ');
  }

  /**
   * FTS5/BM25 lexical probe. `queryTokens` are OR-joined and phrase-quoted so
   * FTS operators embedded in record text stay inert. Returns record ids
   * best-first (lowest bm25). Empty tokens → empty result.
   */
  lexicalSearch(queryTokens: string[]): LexicalHit[] {
    const clean = queryTokens
      .map((token) => token.replace(/"/g, '').trim())
      .filter((token) => token.length > 0);
    if (clean.length === 0) return [];
    const match = clean.map((token) => `"${token}"`).join(' OR ');
    if (!this.lexicalSearchStmt) {
      this.lexicalSearchStmt = this.db.prepare(
        `SELECT id, bm25(records_fts) AS bm25 FROM records_fts
         WHERE records_fts MATCH ? ORDER BY bm25`,
      );
    }
    const rows = this.lexicalSearchStmt.all(match) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: asString(row.id), bm25: asNumber(row.bm25) }));
  }

  /**
   * Rank a candidate pool (or, when omitted, every indexed record) against
   * `tokens` by fusing lexical search with the adapter's own ranked signals
   * via Reciprocal Rank Fusion. Returns full records, best-first. Does not
   * itself run freshness/health checks — callers that need up-to-date results
   * call {@link ensureHealthy} / {@link ensureFresh} first.
   */
  async search(tokens: string[], opts?: { pool?: string[] }): Promise<StoredRecord[]> {
    return rrfSearch(this, this.adapter, tokens, opts?.pool);
  }

  /** Reflected schema table list (for health/diagnostics tests). */
  async inspectSchema(): Promise<{ tables: string[]; schemaVersion: number }> {
    return { tables: this.tableNames(), schemaVersion: this.schemaVersion() };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
