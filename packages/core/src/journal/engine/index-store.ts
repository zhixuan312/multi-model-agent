import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { isUnderIgnoredDir } from '../adapters/ignored-dirs.js';
import { detectGitChanges } from './freshness.js';
import type { FreshnessDecision } from './freshness.js';
import { rrfSearch } from './search.js';
import { isSymbolCorpusAdapter } from './types.js';
import type {
  CorpusAdapter,
  FileRecord,
  IndexHealth,
  LexicalHit,
  StoredRecord,
  StoredRecordMeta,
  SymbolCorpusAdapter,
  SymbolInput,
  SymbolRecord,
  SymbolRecordMeta,
} from './types.js';

/** Default throttle for the non-git full stat-sweep fallback: at most once every 5 minutes per open index. */
const DEFAULT_FALLBACK_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Batch size for the `files`/`symbols` storage mode's prepare-then-write
 * steps ({@link CorpusIndex.rebuildSymbols}, {@link
 * CorpusIndex.syncSymbolsIncremental}, {@link CorpusIndex.syncSymbolPaths}).
 * Each batch is read/hashed/extracted OUTSIDE any transaction and then
 * written inside its own short transaction before the next batch starts —
 * holding every file's extracted symbol bodies for a WHOLE large repository
 * in memory at once (the pre-batching behavior) can exhaust the heap.
 */
const SYMBOL_SYNC_BATCH_SIZE = 256;

/** One file's read/hashed/extracted state, ready to write to `files`/`symbols`. */
type PreparedSymbolFile = { relPath: string; mtimeMs: number; contentHash: string; symbols: SymbolInput[] };

/**
 * One file's incremental-sync plan: either only its `files.mtime_ms` needs
 * refreshing (content unchanged), or its symbols need a full whole-file
 * replace (content changed).
 */
type SymbolSyncPlan =
  | { kind: 'mtime-only'; relPath: string; mtimeMs: number }
  | { kind: 'content-changed'; relPath: string; mtimeMs: number; contentHash: string; symbols: SymbolInput[] };

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
/** Required tables for the `SymbolCorpusAdapter` (files/symbols) storage mode. */
const REQUIRED_FILE_SYMBOL_TABLES = ['files', 'symbols', 'symbols_trgm'];
/**
 * Minimum token length the `trigram` FTS5 tokenizer can answer via `MATCH`:
 * it indexes only 3-character runs, so a shorter `MATCH` pattern silently
 * matches nothing (confirmed against SQLite 3.53), even though `LIKE`
 * against the same table stays correct at any length. Tokens shorter than
 * this fall back to the `LIKE` path in {@link CorpusIndex.symbolCandidateIds}.
 */
const SYMBOL_TRIGRAM_MIN_TOKEN_LENGTH = 3;
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

/**
 * Escape SQLite `LIKE` wildcards (`%`, `_`) and the escape character itself
 * (`\`) in a literal substring, so it can be embedded in a `%<token>%`
 * pattern and matched with `ESCAPE '\'` as a plain substring — not
 * interpreted as a wildcard. Needed because {@link CorpusIndex.symbolTokenMatches}
 * receives caller-supplied query tokens, which may contain `_` (a valid
 * identifier character and also `LIKE`'s single-character wildcard).
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Quote one token as an FTS5 string literal (`"..."`, doubling any embedded
 * `"`), so it is matched as an inert phrase rather than parsed as FTS5 query
 * syntax (column filters, boolean operators, `NEAR`, ...). Used for every
 * `MATCH` query {@link CorpusIndex.symbolCandidateIds} builds against
 * `symbols_trgm`: `tokenize()` (the investigate preprocessor's caller) only
 * ever emits plain `[a-z0-9_]+` tokens, but `rankedSymbolsByTokens` is a
 * general engine method, not an investigate-only one, so it does not assume
 * a caller-supplied token is free of FTS5-meaningful characters.
 */
function fts5QuoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
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
 * Safety gate for the git fast path (see {@link CorpusIndex.syncSymbolPaths}).
 * `FileCorpusAdapter.walk` never follows symlinks — a directory entry's own
 * `Dirent.isFile()` is false for a symlink, so the walk skips it without ever
 * resolving where it points. The git fast path instead receives bare path
 * strings from `git ls-files` / `git status` and previously fed them straight
 * to `readFile`, which DOES dereference symlinks: a tracked symlink pointing
 * outside the corpus root would read and index the TARGET file's content —
 * potentially leaking host file contents into worker prompts. `lstat` (never
 * `stat`, which would itself follow the link) each git-reported path first:
 * reject anything that is not a regular file, and separately reject any path
 * that resolves outside the corpus root (a defense against a path-traversal
 * `relPath`, independent of the symlink check).
 */
/**
 * True when `rel` (a `path.relative()` result) escapes the base it was
 * computed against — either the base itself (`'..'`) or an ancestor-escaping
 * `'..' + sep + ...` prefix. A plain `rel.startsWith('..')` check is too
 * broad: it also rejects a legitimate path whose first segment merely
 * STARTS WITH `..`, such as a tracked `..generated/file.ts` directory, which
 * is a real (if unusual) directory name and not a traversal attempt.
 */
function escapesBase(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
}

async function isSafeGitReportedFile(root: string, relPath: string): Promise<boolean> {
  const resolvedRoot = resolvePath(root);
  const candidate = resolvePath(root, relPath);
  const rel = relative(resolvedRoot, candidate);
  if (escapesBase(rel)) return false;
  let st;
  try {
    st = await lstat(candidate);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  // `resolve()` is lexical: it cannot see a symlinked corpus root or an
  // ancestor directory symlink. Compare canonical filesystem paths as well,
  // so the file we are about to read is truly contained by the corpus root.
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    const canonicalRel = relative(canonicalRoot, canonicalCandidate);
    return !escapesBase(canonicalRel);
  } catch {
    return false;
  }
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
    adapter: CorpusAdapter | SymbolCorpusAdapter;
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
  }): Promise<CorpusIndex> {
    const index = new CorpusIndex(
      opts.root,
      opts.adapter,
      opts.fallbackSweepIntervalMs ?? DEFAULT_FALLBACK_SWEEP_INTERVAL_MS,
      opts.sweepState ?? { lastFallbackSweepAt: null, fallbackSweepCount: 0 },
      opts.dbPath,
    );
    // First-use bootstrap: `new DatabaseSync(<dbPath>)` throws
    // ENOENT/SQLITE_CANTOPEN when its parent dir does not exist yet — true of
    // both the default (`<root>/index.db`) and a caller-supplied override.
    await mkdir(dirname(index.dbPath), { recursive: true });
    index.openDatabase();
    return index;
  }

  private db!: DatabaseSync;
  private freshnessDecision: FreshnessDecision | null = null;
  /**
   * The `CorpusAdapter.rootMtimeMs()` value observed on the last {@link
   * ensureFreshRecords} check that actually ran `listFiles()` — `null`
   * before any check has run. Used to skip that O(corpus) enumeration when
   * the root's mtime is unchanged; irrelevant to the `SymbolCorpusAdapter`
   * (files/symbols) path, which has its own git/stat-sweep freshness logic.
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

  /**
   * Cached prepared statements for the `files`/`symbols` read path (the
   * `SymbolCorpusAdapter` storage mode's hot per-query operations) —
   * the symbol-mode counterpart to the `records`/`records_fts` statements
   * above. Cleared by {@link invalidateSymbolStatements} whenever
   * `files`/`symbols` is dropped and recreated.
   */
  private allSymbolsMetaStmt?: StatementSync;
  private symbolTokenMatchStmt?: StatementSync;
  /** Whole-corpus folder aggregation, returned as one row per folder. */
  private folderSummariesStmt?: StatementSync;
  /** Cached by `IN` placeholder count for targeted post-ranking body reads. */
  private readonly symbolsByIdsStmts = new Map<number, StatementSync>();
  private symbolTrgmMatchCandidatesStmt?: StatementSync;
  private symbolTrgmMatchCountStmt?: StatementSync;
  private readonly symbolTrgmPerTokenMatchCountStmts = new Map<number, StatementSync>();
  private symbolTrgmNameCandidatesStmt?: StatementSync;
  private symbolTrgmBodyCandidatesStmt?: StatementSync;
  /** Cached by `<token count>:<candidate id count>` for final SQL ranking. */
  private readonly symbolCandidateScoreStmts = new Map<string, StatementSync>();

  private constructor(
    private readonly root: string,
    private readonly adapter: CorpusAdapter | SymbolCorpusAdapter,
    private readonly fallbackSweepIntervalMs: number,
    private readonly sweepState: FallbackSweepState,
    private readonly dbPathOverride: string | undefined,
  ) {}

  private get dbPath(): string {
    return this.dbPathOverride ?? join(this.root, CORPUS_INDEX_DB_FILENAME);
  }

  /**
   * True when `relPath` (root-relative) is one of THIS index's own derived
   * SQLite files — the main database, or a WAL/SHM/rollback-journal sidecar.
   * Compares against the ACTUAL configured {@link dbPath}, not a bare
   * basename match: a basename-only check would also match a legitimately
   * named user file living elsewhere in the corpus (e.g. `src/db/index.db`)
   * that has nothing to do with this engine — and, now that a caller may
   * point {@link dbPath} entirely outside the corpus root (see `open()`'s
   * `dbPath` override), no file under the root is ever this index's own
   * artifact, so this correctly stops filtering anything in that case.
   */
  private isOwnArtifactPath(relPath: string): boolean {
    const candidate = resolvePath(this.root, relPath);
    const db = resolvePath(this.dbPath);
    return candidate === db || candidate === `${db}-wal` || candidate === `${db}-shm` || candidate === `${db}-journal`;
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
      db = new DatabaseSync(this.dbPath);
      this.db = db;
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA foreign_keys = ON;');
      this.bootstrapSchema();
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
   * Create only the tables the current adapter's contract needs. The two
   * storage modes never mix in one database file (a one-record-per-file
   * `CorpusAdapter` corpus never touches `files`/`symbols`; a
   * `SymbolCorpusAdapter` corpus never touches
   * `records`/`records_fts`), so there is no reason to pay FTS5
   * virtual-table creation cost, or carry unused tables, for the mode a
   * corpus doesn't use. Both modes still share one `user_version` — the
   * schema version describes "this database's shape is current for its own
   * mode", not a specific table set.
   */
  private ensureSchema(): void {
    if (isSymbolCorpusAdapter(this.adapter)) {
      // `files`/`symbols`: the SymbolCorpusAdapter storage mode (e.g. the
      // repository file adapter). `files` exists ONLY for per-file change
      // detection (mtime + content hash) — it is never searched. `symbols`
      // holds the many addressable rows one source file can produce (heading
      // sections, function/class ranges, or fixed-size blocks); `file_path`
      // is indexed because a changed file's entire symbol set is replaced by
      // exact `file_path` match.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          file_path    TEXT PRIMARY KEY,
          mtime_ms     REAL NOT NULL,
          content_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS symbols (
          id         TEXT PRIMARY KEY,
          file_path  TEXT NOT NULL,
          name       TEXT NOT NULL,
          kind       TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line   INTEGER NOT NULL,
          body       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
        -- Substring-search accelerator for the \`symbols\` table's \`name\`/\`body\`
        -- columns (see {@link CorpusIndex.rankedSymbolsByTokens}). \`name\`/\`body\`
        -- carry no plain SQL index because every existing lookup against them is a
        -- \`LIKE '%token%'\` substring match, which a btree index cannot serve (a
        -- leading wildcard defeats prefix ordering). FTS5's \`trigram\` tokenizer
        -- exists specifically to accelerate \`LIKE\`/\`GLOB\` substring queries: it
        -- indexes every 3-character run of the source text, so a query still
        -- expressed as an ordinary \`name LIKE ?\` / \`body LIKE ?\` predicate against
        -- THIS table can be satisfied from the trigram index instead of a full
        -- table scan, while a \`case_sensitive 0\` tokenizer keeps matches
        -- case-insensitive, matching \`LIKE\`'s own default ASCII semantics exactly
        -- (verified empirically against SQLite 3.53's \`node:sqlite\` binding).
        -- \`id\`/\`file_path\` are UNINDEXED passenger columns: they are never
        -- searched here, only projected/filtered by exact value, so paying to
        -- trigram-index them would be pure waste. Kept in exact row-for-row sync
        -- with \`symbols\` at every write path (see {@link writeSymbolFileBatch},
        -- {@link applySymbolSyncPlans}, {@link deleteSymbolFilesBatch}).
        CREATE VIRTUAL TABLE IF NOT EXISTS symbols_trgm USING fts5(
          id UNINDEXED,
          file_path UNINDEXED,
          name,
          body,
          tokenize = 'trigram case_sensitive 0'
        );
      `);
    } else {
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
    }
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

  /** True when every required `files`/`symbols` table exists (the SymbolCorpusAdapter storage mode), no legacy table is present, and the schema version matches. Same table-first ordering as {@link schemaIsValid}, for the same reason. */
  private fileSymbolTablesValid(): boolean {
    let tables: string[];
    try {
      tables = this.tableNames();
    } catch {
      return false;
    }
    if (LEGACY_TABLES.some((name) => tables.includes(name))) return false;
    if (!REQUIRED_FILE_SYMBOL_TABLES.every((name) => tables.includes(name))) return false;
    return this.schemaVersion() === CORPUS_INDEX_SCHEMA_VERSION;
  }

  /**
   * Open + required-table + schema-version check. If the derived cache is
   * missing tables or on the wrong schema version, drop and rebuild it from
   * the authoritative source files. Freshness (new/changed files) is the job
   * of {@link syncIncremental}, not this method.
   */
  async ensureHealthy(): Promise<IndexHealth> {
    const valid = isSymbolCorpusAdapter(this.adapter) ? this.fileSymbolTablesValid() : this.schemaIsValid();
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
  private symbolFilesCount(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM files').get() as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  /**
   * Cheap per-query freshness gate.
   *
   * `SymbolCorpusAdapter` corpora (the repository file adapter) use the
   * SUBLINEAR git-metadata path in {@link ensureFreshSymbols} whenever the
   * corpus root is a git work tree: `git status --porcelain` reports exactly
   * what changed since the last commit in one subprocess call, so this
   * process never `fs.stat`s the whole corpus. Only a non-git root falls back
   * to a full stat sweep, and that fallback is explicitly throttled — see
   * {@link ensureFreshSymbols} — so it cannot run on every query either.
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
    if (isSymbolCorpusAdapter(this.adapter)) {
      if (!this.fileSymbolTablesValid()) {
        await this.rebuild();
        return;
      }
      await this.ensureFreshSymbols(this.adapter);
      return;
    }
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
   * The `SymbolCorpusAdapter` (repository) half of {@link ensureFresh}. Never
   * calls `this.adapter.listFiles()` (a corpus-wide directory walk) on this
   * path — see the two branches below.
   */
  private async ensureFreshSymbols(adapter: SymbolCorpusAdapter): Promise<void> {
    // A schema-valid but EMPTY `files` table — the very first `ensureFresh()`
    // after `CorpusIndex.open()` bootstrapped a fresh database — has nothing
    // indexed yet to diff against. Only THIS case needs `git ls-files`: every
    // other (steady-state) call must cost exactly one `git status` subprocess,
    // not two — `symbolFilesCount() === 0` is a single cheap `SELECT
    // count(*)`, computed once and reused for both the tracked-file request
    // and the empty-index union below.
    const isEmptyIndex = this.symbolFilesCount() === 0;
    const gitChanges = await detectGitChanges(this.root, { includeTracked: isEmptyIndex });
    if (gitChanges !== null) {
      // Git path: `git status --porcelain` already told us exactly what
      // changed — no corpus-wide `fs.stat` sweep, ever. Exclude this index's
      // own derived-database artifacts, IF they happen to live inside the
      // corpus root (see {@link isOwnArtifactPath} — never true once a caller
      // points `dbPath` outside the root), and anything under an ignored
      // directory (`node_modules`/`dist`/`build`/`.git`) — the SAME predicate
      // `FileCorpusAdapter.walk` applies while pruning directories, applied
      // here explicitly because this path receives a flat list of git-reported
      // paths with no directory structure left to prune.
      const trackedPaths = gitChanges.trackedPaths.filter((path) => !this.isOwnArtifactPath(path) && !isUnderIgnoredDir(path));
      const statusChangedPaths = gitChanges.changedPaths.filter(
        (path) => !this.isOwnArtifactPath(path) && !isUnderIgnoredDir(path),
      );
      const deletedPaths = gitChanges.deletedPaths.filter((path) => !this.isOwnArtifactPath(path) && !isUnderIgnoredDir(path));
      // `git status` alone reports only what changed SINCE the last commit,
      // which is nothing for a clean working tree: taking only
      // `statusChangedPaths` here would leave a first-time index against an
      // already-committed repository empty forever. On a genuinely empty
      // index, treat every git-KNOWN path (tracked, plus anything `git
      // status` already flags as new/modified) as needing indexing, not only
      // today's diff.
      const changedPaths = isEmptyIndex ? Array.from(new Set([...trackedPaths, ...statusChangedPaths])) : statusChangedPaths;
      if (changedPaths.length > 0 || deletedPaths.length > 0) {
        await this.syncSymbolPaths(adapter, changedPaths, deletedPaths);
      }
      this.freshnessDecision = {
        mode: 'git',
        statSweep: false,
        trackedPaths,
        changedPaths,
        deletedPaths,
      };
      return;
    }

    // Non-git fallback: a full stat sweep is the only way to detect drift
    // without git metadata, so throttle it — it must not run on every query.
    // `this.sweepState` (see {@link FallbackSweepState}) may be shared across
    // several `CorpusIndex` instances opened for the same root, so the
    // throttle survives a caller that opens+closes a fresh instance per call.
    const now = Date.now();
    const dueForSweep =
      this.sweepState.lastFallbackSweepAt === null ||
      now - this.sweepState.lastFallbackSweepAt >= this.fallbackSweepIntervalMs;
    if (dueForSweep) {
      await this.syncSymbolsIncremental(adapter);
      this.sweepState.lastFallbackSweepAt = now;
      this.sweepState.fallbackSweepCount += 1;
    }
    this.freshnessDecision = { mode: 'stat', statSweep: dueForSweep, sweepCount: this.sweepState.fallbackSweepCount };
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
  private async syncSymbolPaths(
    adapter: SymbolCorpusAdapter,
    changedPaths: string[],
    deletedPaths: string[],
  ): Promise<void> {
    const pathsToDelete = new Set(deletedPaths);

    // Prepare and write in BOUNDED BATCHES (see {@link SYMBOL_SYNC_BATCH_SIZE}):
    // `changedPaths` can be the WHOLE git-tracked file set (a first-time
    // index against an already-committed repository), so holding every
    // file's extracted symbol bodies in memory at once — the pre-batching
    // behavior — could exhaust the heap. Each batch is still fully prepared
    // (filesystem I/O + extraction) OUTSIDE any transaction, same reasoning
    // as `rebuildSymbols`/`syncSymbolsIncremental`: the SQLite writer lock
    // must cover only the resulting delete/upsert statements.
    for (let i = 0; i < changedPaths.length; i += SYMBOL_SYNC_BATCH_SIZE) {
      const batch = changedPaths.slice(i, i + SYMBOL_SYNC_BATCH_SIZE);
      const prepared: PreparedSymbolFile[] = [];
      for (const relPath of batch) {
        if (!(await isSafeGitReportedFile(this.root, relPath))) {
          console.warn(`[corpus-engine:${adapter.corpusId}] skipping non-regular or unsafe git-reported path ${relPath}`);
          pathsToDelete.add(relPath);
          continue;
        }

        const fullPath = join(this.root, relPath);
        let raw: string;
        let mtimeMs: number;
        let fh: FileHandle | undefined;
        try {
          // Close the validate-then-read TOCTOU gap: `isSafeGitReportedFile`
          // just canonicalized `fullPath` and rejected a symlink, but a
          // process with write access to the repository could still swap the
          // validated file for a symlink between that check and this read.
          // `O_NOFOLLOW` makes the open itself fail outright when the FINAL
          // path component is a symlink, so the descriptor read below is
          // provably the SAME regular file that was just validated — not
          // whatever a race swapped it for.
          //
          // Residual risk: this protects only the final path component. An
          // attacker who swaps an ANCESTOR DIRECTORY mid-flight is not closed
          // by this — Node has no ergonomic per-component `openat` — so that
          // narrower race remains a known, accepted limitation.
          fh = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          const st = await fh.stat();
          if (!st.isFile()) throw new Error(`not a regular file: ${relPath}`);
          raw = await fh.readFile('utf8');
          mtimeMs = st.mtimeMs;
        } catch (error) {
          // ELOOP (final component became a symlink), ENOENT (vanished
          // between `git status` and this open — an ordinary race), EACCES
          // (permission race) — all treated exactly like a deleted path
          // rather than failing the whole sync.
          console.warn(
            `[corpus-engine:${adapter.corpusId}] skipping unreadable changed file ${relPath}: ${(error as Error).message}`,
          );
          pathsToDelete.add(relPath);
          continue;
        } finally {
          await fh?.close();
        }

        const contentHash = createHash('sha256').update(raw).digest('hex');
        let symbols: SymbolInput[];
        try {
          symbols = await adapter.extractSymbols(relPath, raw);
        } catch (error) {
          console.warn(
            `[corpus-engine:${adapter.corpusId}] extractSymbols failed for ${relPath}, skipping: ${(error as Error).message}`,
          );
          continue;
        }
        prepared.push({ relPath, mtimeMs, contentHash, symbols });
      }
      this.writeSymbolFileBatch(prepared);
    }

    this.deleteSymbolFilesBatch([...pathsToDelete]);
  }

  /**
   * Delete-then-upsert one BATCH of prepared `files`/`symbols` rows inside
   * its own short transaction. Shared by {@link rebuildSymbols}, {@link
   * syncSymbolsIncremental} (via {@link applySymbolSyncPlans}), and {@link
   * syncSymbolPaths}. A delete against a non-existent row is a no-op, so this
   * is also a valid write for a freshly (re)created table.
   */
  private writeSymbolFileBatch(prepared: PreparedSymbolFile[]): void {
    if (prepared.length === 0) return;
    const deleteSymbolsForFile = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const deleteSymbolsTrgmForFile = this.db.prepare('DELETE FROM symbols_trgm WHERE file_path = ?');
    const upsertFile = this.db.prepare(
      `INSERT INTO files (file_path, mtime_ms, content_hash) VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash`,
    );
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSymbolTrgm = this.db.prepare(`INSERT INTO symbols_trgm (id, file_path, name, body) VALUES (?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const { relPath, mtimeMs, contentHash, symbols } of prepared) {
        deleteSymbolsForFile.run(relPath);
        deleteSymbolsTrgmForFile.run(relPath);
        upsertFile.run(relPath, mtimeMs, contentHash);
        symbols.forEach((symbol, position) => {
          const id = `${relPath}#${position}`;
          insertSymbol.run(id, relPath, symbol.name, symbol.kind, symbol.startLine, symbol.endLine, symbol.body);
          insertSymbolTrgm.run(id, relPath, symbol.name, symbol.body);
        });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Delete every `files`/`symbols`/`symbols_trgm` row for the given paths inside one short transaction. */
  private deleteSymbolFilesBatch(relPaths: string[]): void {
    if (relPaths.length === 0) return;
    const deleteSymbolsForFile = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const deleteSymbolsTrgmForFile = this.db.prepare('DELETE FROM symbols_trgm WHERE file_path = ?');
    const deleteFile = this.db.prepare('DELETE FROM files WHERE file_path = ?');
    this.db.exec('BEGIN');
    try {
      for (const relPath of relPaths) {
        deleteSymbolsForFile.run(relPath);
        deleteSymbolsTrgmForFile.run(relPath);
        deleteFile.run(relPath);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

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
  private invalidateSymbolStatements(): void {
    this.allSymbolsMetaStmt = undefined;
    this.symbolTokenMatchStmt = undefined;
    this.folderSummariesStmt = undefined;
    this.symbolsByIdsStmts.clear();
    this.symbolTrgmMatchCandidatesStmt = undefined;
    this.symbolTrgmMatchCountStmt = undefined;
    this.symbolTrgmPerTokenMatchCountStmts.clear();
    this.symbolTrgmNameCandidatesStmt = undefined;
    this.symbolTrgmBodyCandidatesStmt = undefined;
    this.symbolCandidateScoreStmts.clear();
  }

  private dropAndRecreateSchema(): void {
    this.invalidateRecordStatements();
    this.db.exec(`
      DROP TABLE IF EXISTS records;
      DROP TABLE IF EXISTS records_fts;
    `);
    this.dropLegacyTables();
    this.ensureSchema();
  }

  private dropAndRecreateFileSymbolTables(): void {
    this.invalidateRecordStatements();
    this.invalidateSymbolStatements();
    this.db.exec(`
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS symbols_trgm;
      DROP TABLE IF EXISTS files;
    `);
    this.dropLegacyTables();
    this.ensureSchema();
  }

  /**
   * Full rebuild: recreate the schema and re-derive every row from the
   * adapter's source files. Dispatches by adapter contract:
   * `SymbolCorpusAdapter` (many symbols per file) uses the `files`/`symbols`
   * tables; `CorpusAdapter` (one record per file) uses `records`/`records_fts`.
   */
  async rebuild(): Promise<void> {
    if (isSymbolCorpusAdapter(this.adapter)) {
      await this.rebuildSymbols(this.adapter);
      return;
    }
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
  private async rebuildSymbols(adapter: SymbolCorpusAdapter): Promise<void> {
    this.dropAndRecreateFileSymbolTables();
    // Exclude this index's own derived-database artifacts, IF they happen to
    // live inside the corpus root (see {@link isOwnArtifactPath} — never
    // true once a caller points `dbPath` outside the root, e.g. the
    // investigate preprocessor). The adapter itself is corpus-neutral and has
    // no notion of "where does the derived database live" — only the engine
    // knows the actual configured `dbPath`.
    const files = (await adapter.listFiles()).filter((relPath) => !this.isOwnArtifactPath(relPath));

    for (let i = 0; i < files.length; i += SYMBOL_SYNC_BATCH_SIZE) {
      const batchFiles = files.slice(i, i + SYMBOL_SYNC_BATCH_SIZE);
      const prepared = await this.prepareSymbolFiles(adapter, batchFiles);
      const fresh = await this.reprepareDriftedSymbolFiles(adapter, prepared);
      this.writeSymbolFileBatch(fresh);
    }
  }

  /**
   * Read, hash, and extract symbols for each of `relPaths`, entirely outside
   * any transaction. Unreadable/undecodable files are warned-and-skipped
   * rather than aborting the whole batch.
   */
  private async prepareSymbolFiles(adapter: SymbolCorpusAdapter, relPaths: string[]): Promise<PreparedSymbolFile[]> {
    const prepared: PreparedSymbolFile[] = [];
    for (const relPath of relPaths) {
      let raw: string;
      let mtimeMs: number;
      try {
        const fullPath = join(this.root, relPath);
        raw = await readFile(fullPath, 'utf8');
        mtimeMs = (await stat(fullPath)).mtimeMs;
      } catch (error) {
        console.warn(`[corpus-engine:${adapter.corpusId}] skipping unreadable file ${relPath}: ${(error as Error).message}`);
        continue;
      }
      const contentHash = createHash('sha256').update(raw).digest('hex');
      // Tier 3 (fixed-size blocks) is a NON-FAILING fallback per the adapter
      // contract, but a rogue adapter implementation is still tolerated here
      // exactly like the records-mode decode() path: skip-and-warn rather
      // than abort the whole rebuild.
      let symbols: SymbolInput[];
      try {
        symbols = await adapter.extractSymbols(relPath, raw);
      } catch (error) {
        console.warn(
          `[corpus-engine:${adapter.corpusId}] extractSymbols failed for ${relPath}, skipping: ${(error as Error).message}`,
        );
        continue;
      }
      prepared.push({ relPath, mtimeMs, contentHash, symbols });
    }
    return prepared;
  }

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
  private async reprepareDriftedSymbolFiles(
    adapter: SymbolCorpusAdapter,
    prepared: PreparedSymbolFile[],
  ): Promise<PreparedSymbolFile[]> {
    const fresh: PreparedSymbolFile[] = [];
    for (const entry of prepared) {
      let currentMtimeMs: number;
      try {
        currentMtimeMs = (await stat(join(this.root, entry.relPath))).mtimeMs;
      } catch (error) {
        console.warn(
          `[corpus-engine:${adapter.corpusId}] ${entry.relPath} vanished after preparation, dropping from this batch: ${(error as Error).message}`,
        );
        continue;
      }
      if (currentMtimeMs === entry.mtimeMs) {
        fresh.push(entry);
        continue;
      }
      const [reprepared] = await this.prepareSymbolFiles(adapter, [entry.relPath]);
      if (reprepared) fresh.push(reprepared);
    }
    return fresh;
  }

  /**
   * Incremental sync keyed by source path + mtime + content hash. Only files
   * whose mtime AND content hash differ from the stored row are re-decoded and
   * upserted; files that vanished are dropped. Cheap enough to run before
   * every retrieval. Dispatches by adapter contract, same as {@link rebuild}.
   */
  async syncIncremental(): Promise<void> {
    if (isSymbolCorpusAdapter(this.adapter)) {
      await this.syncSymbolsIncremental(this.adapter);
      return;
    }
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
  private async syncSymbolsIncremental(adapter: SymbolCorpusAdapter): Promise<void> {
    if (!this.fileSymbolTablesValid()) {
      await this.rebuild();
      return;
    }
    const existing = new Map<string, { mtimeMs: number; contentHash: string }>();
    const rows = this.db
      .prepare('SELECT file_path, mtime_ms, content_hash FROM files')
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      existing.set(asString(row.file_path), {
        mtimeMs: asNumber(row.mtime_ms),
        contentHash: asString(row.content_hash),
      });
    }

    // Same own-artifact exclusion as {@link rebuildSymbols} — see there for why.
    const files = (await adapter.listFiles()).filter((relPath) => !this.isOwnArtifactPath(relPath));
    const seenPaths = new Set<string>();

    // Read, hash, and (when content changed) extract symbols in BOUNDED
    // BATCHES (see {@link SYMBOL_SYNC_BATCH_SIZE}), applying each batch's
    // writes in its own short transaction before moving to the next — same
    // reasoning as {@link rebuildSymbols}: this loop is async I/O/CPU work
    // that must not hold SQLite's writer lock while it runs, and holding
    // every file's plan (with a content change's extracted symbol bodies)
    // for the WHOLE corpus in memory at once could exhaust the heap.
    for (let i = 0; i < files.length; i += SYMBOL_SYNC_BATCH_SIZE) {
      const batch = files.slice(i, i + SYMBOL_SYNC_BATCH_SIZE);
      const plans: SymbolSyncPlan[] = [];
      for (const relPath of batch) {
        seenPaths.add(relPath);
        const fullPath = join(this.root, relPath);
        let st;
        try {
          st = await stat(fullPath);
        } catch (error) {
          console.warn(`[corpus-engine:${adapter.corpusId}] skipping unreadable file ${relPath}: ${(error as Error).message}`);
          continue;
        }
        const prior = existing.get(relPath);

        let raw: string;
        try {
          raw = await readFile(fullPath, 'utf8');
        } catch (error) {
          console.warn(`[corpus-engine:${adapter.corpusId}] skipping unreadable file ${relPath}: ${(error as Error).message}`);
          continue;
        }
        const contentHash = createHash('sha256').update(raw).digest('hex');
        if (prior && prior.contentHash === contentHash) {
          // Content identical — refresh a changed mtime but never re-parse.
          // An explicit incremental sync deliberately hashes the source even
          // when its timestamp is unchanged: timestamp resolution and a
          // preserved mtime must not hide a genuine content change.
          if (prior.mtimeMs !== st.mtimeMs) {
            plans.push({ kind: 'mtime-only', relPath, mtimeMs: st.mtimeMs });
          }
          continue;
        }
        let symbols: SymbolInput[];
        try {
          symbols = await adapter.extractSymbols(relPath, raw);
        } catch (error) {
          console.warn(
            `[corpus-engine:${adapter.corpusId}] extractSymbols failed for ${relPath}, skipping: ${(error as Error).message}`,
          );
          continue;
        }
        plans.push({ kind: 'content-changed', relPath, mtimeMs: st.mtimeMs, contentHash, symbols });
      }
      this.applySymbolSyncPlans(plans);
    }

    // Files whose path disappeared from this listing entirely — determined
    // from the DB snapshot read above `files`/`seenPaths`; no I/O needed.
    const deletedPaths: string[] = [];
    for (const relPath of existing.keys()) {
      if (!seenPaths.has(relPath)) deletedPaths.push(relPath);
    }
    this.deleteSymbolFilesBatch(deletedPaths);
  }

  /** Apply one batch of {@link SymbolSyncPlan}s inside its own short transaction. */
  private applySymbolSyncPlans(plans: SymbolSyncPlan[]): void {
    if (plans.length === 0) return;
    const upsertFile = this.db.prepare(
      `INSERT INTO files (file_path, mtime_ms, content_hash) VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash`,
    );
    const updateMtimeOnly = this.db.prepare('UPDATE files SET mtime_ms = ? WHERE file_path = ?');
    const deleteSymbolsForFile = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const deleteSymbolsTrgmForFile = this.db.prepare('DELETE FROM symbols_trgm WHERE file_path = ?');
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSymbolTrgm = this.db.prepare(`INSERT INTO symbols_trgm (id, file_path, name, body) VALUES (?, ?, ?, ?)`);

    this.db.exec('BEGIN');
    try {
      for (const plan of plans) {
        if (plan.kind === 'mtime-only') {
          updateMtimeOnly.run(plan.mtimeMs, plan.relPath);
          continue;
        }
        // Whole-file replace: never attempt per-symbol change detection — an
        // edit shifts the line numbers of every symbol below it anyway.
        deleteSymbolsForFile.run(plan.relPath);
        deleteSymbolsTrgmForFile.run(plan.relPath);
        upsertFile.run(plan.relPath, plan.mtimeMs, plan.contentHash);
        plan.symbols.forEach((symbol, position) => {
          const id = `${plan.relPath}#${position}`;
          insertSymbol.run(id, plan.relPath, symbol.name, symbol.kind, symbol.startLine, symbol.endLine, symbol.body);
          insertSymbolTrgm.run(id, plan.relPath, symbol.name, symbol.body);
        });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

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
  async symbolsForFile(filePath: string): Promise<SymbolRecord[]> {
    const rows = this.db
      .prepare('SELECT id, file_path, name, kind, start_line, end_line, body FROM symbols WHERE file_path = ? ORDER BY start_line, id')
      .all(filePath) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      filePath: asString(row.file_path),
      name: asString(row.name),
      kind: asString(row.kind),
      startLine: asNumber(row.start_line),
      endLine: asNumber(row.end_line),
      body: asString(row.body),
    }));
  }

  /**
   * Every `symbols` row across the WHOLE corpus (the `files`/`symbols`
   * storage mode), unordered. {@link symbolsForFile} answers "what does this
   * one known file contain"; this answers "what does the corpus contain" —
   * the shape a corpus-wide candidate search (e.g. the investigate
   * preprocessor) needs and no per-file lookup can serve.
   */
  async allSymbols(): Promise<SymbolRecord[]> {
    const rows = this.db
      .prepare('SELECT id, file_path, name, kind, start_line, end_line, body FROM symbols')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      filePath: asString(row.file_path),
      name: asString(row.name),
      kind: asString(row.kind),
      startLine: asNumber(row.start_line),
      endLine: asNumber(row.end_line),
      body: asString(row.body),
    }));
  }

  /**
   * Every `files` row (the `files`/`symbols` storage mode) — per-file
   * change-detection metadata (path, mtime, content hash) only, never
   * content. Used alongside {@link allSymbols} to build a folder-level map
   * of the whole corpus without enumerating every file's content.
   */
  async allFiles(): Promise<FileRecord[]> {
    const rows = this.db
      .prepare('SELECT file_path, mtime_ms, content_hash FROM files')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      filePath: asString(row.file_path),
      mtimeMs: asNumber(row.mtime_ms),
      contentHash: asString(row.content_hash),
    }));
  }

  /**
   * Every `symbols` row's metadata ONLY — id/path/name/kind/line-range, never
   * `body` (the `files`/`symbols` storage mode's counterpart to
   * {@link allRecordsMeta}). Ranking a symbol corpus (candidate scoring, the
   * folder-level map the investigate preprocessor builds) needs none of a
   * symbol's body text; only a caller that will actually return a symbol's
   * text should pay to project it (see {@link symbolsByIds}). Same row set as
   * {@link allSymbols}, just a cheaper column list.
   */
  async allSymbolsMeta(): Promise<SymbolRecordMeta[]> {
    if (!this.allSymbolsMetaStmt) {
      this.allSymbolsMetaStmt = this.db.prepare('SELECT id, file_path, name, kind, start_line, end_line FROM symbols');
    }
    const rows = this.allSymbolsMetaStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      filePath: asString(row.file_path),
      name: asString(row.name),
      kind: asString(row.kind),
      startLine: asNumber(row.start_line),
      endLine: asNumber(row.end_line),
    }));
  }

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
  symbolTokenMatches(token: string): { nameMatches: string[]; bodyMatches: string[] } {
    const pattern = `%${escapeLikeLiteral(token)}%`;
    if (!this.symbolTokenMatchStmt) {
      this.symbolTokenMatchStmt = this.db.prepare(
        `SELECT id, (name LIKE ? ESCAPE '\\') AS name_hit, (body LIKE ? ESCAPE '\\') AS body_hit
         FROM symbols
         WHERE name LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'`,
      );
    }
    const rows = this.symbolTokenMatchStmt.all(pattern, pattern, pattern, pattern) as Array<Record<string, unknown>>;
    const nameMatches: string[] = [];
    const bodyMatches: string[] = [];
    for (const row of rows) {
      const id = asString(row.id);
      if (asNumber(row.name_hit) === 1) nameMatches.push(id);
      if (asNumber(row.body_hit) === 1) bodyMatches.push(id);
    }
    return { nameMatches, bodyMatches };
  }

  /**
   * Produces the FTS-backed candidate ids for a ranked symbol query. For
   * multi-token searches, a rarity-first prefix caps the FTS fanout at the
   * requested result limit. Tokens with no matching rows are excluded before
   * prefix selection so they cannot consume the guaranteed first slot.
   */
  private symbolCandidateIds(tokens: string[], limit: number): string[] {
    const usable = tokens.filter((token) => token.length >= SYMBOL_TRIGRAM_MIN_TOKEN_LENGTH);
    const short = tokens.filter((token) => token.length < SYMBOL_TRIGRAM_MIN_TOKEN_LENGTH);
    let selected = usable;

    // FTS5's trigram index has no correct indexed lookup for a <3-character
    // substring. Retain the exact LIKE path for these uncommon tokens rather
    // than silently changing the match contract.
    if (short.length === 0 && usable.length > 1) {
      if (!this.symbolTrgmMatchCountStmt) {
        this.symbolTrgmMatchCountStmt = this.db.prepare('SELECT count(*) AS n FROM symbols_trgm WHERE symbols_trgm MATCH ?');
      }
      const total = asNumber(
        (this.symbolTrgmMatchCountStmt.get(usable.map(fts5QuoteToken).join(' OR ')) as Record<string, unknown> | undefined)?.n,
      );
      if (total > limit) {
        let stmt = this.symbolTrgmPerTokenMatchCountStmts.get(usable.length);
        if (!stmt) {
          stmt = this.db.prepare(usable.map(() => 'SELECT count(*) AS n FROM symbols_trgm WHERE symbols_trgm MATCH ?').join(' UNION ALL '));
          this.symbolTrgmPerTokenMatchCountStmts.set(usable.length, stmt);
        }
        const rows = stmt.all(...usable.map(fts5QuoteToken)) as Array<Record<string, unknown>>;
        const counted = usable
          .map((token, i) => ({ token, n: asNumber(rows[i]?.n) }))
          .filter(({ n }) => n > 0)
          .sort((a, b) => a.n - b.n);
        let sum = 0;
        selected = [];
        for (const { token, n } of counted) {
          if (selected.length > 0 && sum + n > limit) break;
          selected.push(token);
          sum += n;
        }
      }
    }

    const ids = new Set<string>();
    if (selected.length > 0) {
      if (!this.symbolTrgmMatchCandidatesStmt) {
        this.symbolTrgmMatchCandidatesStmt = this.db.prepare('SELECT id FROM symbols_trgm WHERE symbols_trgm MATCH ?');
      }
      for (const row of this.symbolTrgmMatchCandidatesStmt.all(selected.map(fts5QuoteToken).join(' OR ')) as Array<Record<string, unknown>>) {
        ids.add(asString(row.id));
      }
    }
    if (short.length > 0) {
      if (!this.symbolTrgmNameCandidatesStmt) this.symbolTrgmNameCandidatesStmt = this.db.prepare("SELECT id FROM symbols_trgm WHERE name LIKE ? ESCAPE '\\'");
      if (!this.symbolTrgmBodyCandidatesStmt) this.symbolTrgmBodyCandidatesStmt = this.db.prepare("SELECT id FROM symbols_trgm WHERE body LIKE ? ESCAPE '\\'");
      for (const token of short) {
        const pattern = `%${escapeLikeLiteral(token)}%`;
        for (const row of this.symbolTrgmNameCandidatesStmt.all(pattern) as Array<Record<string, unknown>>) ids.add(asString(row.id));
        for (const row of this.symbolTrgmBodyCandidatesStmt.all(pattern) as Array<Record<string, unknown>>) ids.add(asString(row.id));
      }
    }
    return [...ids];
  }

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
  async rankedSymbolsByTokens(tokens: string[], limit: number): Promise<SymbolRecordMeta[]> {
    if (tokens.length === 0 || limit <= 0) return [];
    const candidateIds = this.symbolCandidateIds(tokens, limit);
    if (candidateIds.length === 0) return [];
    const key = `${tokens.length}:${candidateIds.length}`;
    let stmt = this.symbolCandidateScoreStmts.get(key);
    if (!stmt) {
      const scoreTerms = tokens.map(
        () => `(CASE WHEN name LIKE ? ESCAPE '\\' THEN 3 ELSE 0 END + CASE WHEN body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`,
      );
      stmt = this.db.prepare(
        `SELECT id, file_path, name, kind, start_line, end_line
         FROM (
           SELECT id, file_path, name, kind, start_line, end_line,
             ${scoreTerms.join(' + ')} AS score
           FROM symbols
           WHERE id IN (${candidateIds.map(() => '?').join(', ')})
         )
         WHERE score > 0
         ORDER BY score DESC, file_path ASC, start_line ASC
         LIMIT ?`,
      );
      this.symbolCandidateScoreStmts.set(key, stmt);
    }
    const patterns = tokens.map((token) => `%${escapeLikeLiteral(token)}%`);
    const scoreBindings = patterns.flatMap((pattern) => [pattern, pattern]);
    const rows = stmt.all(...scoreBindings, ...candidateIds, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      filePath: asString(row.file_path),
      name: asString(row.name),
      kind: asString(row.kind),
      startLine: asNumber(row.start_line),
      endLine: asNumber(row.end_line),
    }));
  }

  /**
   * Folder-level file and symbol counts for the whole indexed corpus. SQLite
   * does the aggregation so callers don't have to materialize every file or
   * symbol merely to build a compact folder map.
   */
  folderSummaries(): Array<{ folder: string; fileCount: number; symbolCount: number }> {
    if (!this.folderSummariesStmt) {
      // Strip the final path component using only built-in SQLite functions:
      // remove trailing non-slash characters, then the remaining slash. A
      // root-level path becomes an empty string, normalized to `.`.
      const folder = "COALESCE(NULLIF(rtrim(rtrim(file_path, replace(file_path, '/', '')), '/'), ''), '.')";
      this.folderSummariesStmt = this.db.prepare(
        `SELECT folder, SUM(file_count) AS file_count, SUM(symbol_count) AS symbol_count
         FROM (
           SELECT ${folder} AS folder, 1 AS file_count, 0 AS symbol_count FROM files
           UNION ALL
           SELECT ${folder} AS folder, 0 AS file_count, 1 AS symbol_count FROM symbols
         )
         GROUP BY folder
         ORDER BY symbol_count DESC, file_count DESC, folder ASC`,
      );
    }
    const rows = this.folderSummariesStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      folder: asString(row.folder),
      fileCount: asNumber(row.file_count),
      symbolCount: asNumber(row.symbol_count),
    }));
  }

  /**
   * Full `symbols` rows (including `body`) for exactly the given ids — the
   * `files`/`symbols` storage mode's counterpart to {@link recordsByIds}. The
   * targeted lookup a caller runs once to materialize text for the symbols it
   * has already decided, via {@link rankedSymbolsByTokens}, that it will
   * actually return. Unmatched ids are silently
   * omitted. Empty `ids` short-circuits without touching the database.
   */
  async symbolsByIds(ids: string[]): Promise<SymbolRecord[]> {
    if (ids.length === 0) return [];
    let stmt = this.symbolsByIdsStmts.get(ids.length);
    if (!stmt) {
      const placeholders = ids.map(() => '?').join(', ');
      stmt = this.db.prepare(
        `SELECT id, file_path, name, kind, start_line, end_line, body FROM symbols WHERE id IN (${placeholders})`,
      );
      this.symbolsByIdsStmts.set(ids.length, stmt);
    }
    const rows = stmt.all(...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      filePath: asString(row.file_path),
      name: asString(row.name),
      kind: asString(row.kind),
      startLine: asNumber(row.start_line),
      endLine: asNumber(row.end_line),
      body: asString(row.body),
    }));
  }

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
    if (isSymbolCorpusAdapter(this.adapter)) {
      throw new Error(
        `[corpus-engine:${this.adapter.corpusId}] search() ranks the records/records_fts schema; ` +
          `a SymbolCorpusAdapter's rows live in files/symbols — use symbolsForFile() instead.`,
      );
    }
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
