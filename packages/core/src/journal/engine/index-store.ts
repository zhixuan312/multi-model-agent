import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rrfSearch } from './search.js';
import { isSymbolCorpusAdapter } from './types.js';
import type {
  CorpusAdapter,
  IndexHealth,
  LexicalHit,
  StoredRecord,
  SymbolCorpusAdapter,
  SymbolInput,
  SymbolRecord,
} from './types.js';

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

export const CORPUS_INDEX_SCHEMA_VERSION = 2;
export const CORPUS_INDEX_DB_FILENAME = 'index.db';

const REQUIRED_TABLES = ['records', 'records_fts'];
/** Required tables for the `SymbolCorpusAdapter` (files/symbols) storage mode. */
const REQUIRED_FILE_SYMBOL_TABLES = ['files', 'symbols'];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export class CorpusIndex {
  static async open(opts: {
    root: string;
    adapter: CorpusAdapter | SymbolCorpusAdapter;
  }): Promise<CorpusIndex> {
    const index = new CorpusIndex(opts.root, opts.adapter);
    // First-use bootstrap: `new DatabaseSync(<root>/index.db)` throws
    // ENOENT/SQLITE_CANTOPEN when the parent dir does not exist yet.
    await mkdir(opts.root, { recursive: true });
    index.openDatabase();
    return index;
  }

  private db!: DatabaseSync;

  private constructor(
    private readonly root: string,
    private readonly adapter: CorpusAdapter | SymbolCorpusAdapter,
  ) {}

  private get dbPath(): string {
    return join(this.root, CORPUS_INDEX_DB_FILENAME);
  }

  private openDatabase(): void {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.bootstrapSchema();
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
    const hasAnyKnownTable = [...REQUIRED_TABLES, ...REQUIRED_FILE_SYMBOL_TABLES].some((name) =>
      tables.includes(name),
    );
    if (hasAnyKnownTable) return;
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
          adapter_meta TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          id UNINDEXED,
          title,
          body,
          tokenize = 'porter unicode61'
        );
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

  /** True when every required table exists and the schema version matches. */
  private schemaIsValid(): boolean {
    let tables: string[];
    try {
      tables = this.tableNames();
    } catch {
      return false;
    }
    if (this.schemaVersion() !== CORPUS_INDEX_SCHEMA_VERSION) return false;
    return REQUIRED_TABLES.every((name) => tables.includes(name));
  }

  /** True when every required `files`/`symbols` table exists (the SymbolCorpusAdapter storage mode). */
  private fileSymbolTablesValid(): boolean {
    let tables: string[];
    try {
      tables = this.tableNames();
    } catch {
      return false;
    }
    if (this.schemaVersion() !== CORPUS_INDEX_SCHEMA_VERSION) return false;
    return REQUIRED_FILE_SYMBOL_TABLES.every((name) => tables.includes(name));
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
    const row = this.db.prepare('SELECT count(*) AS n FROM records').get() as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  /** Indexed `files` row count — a single cheap `SELECT count(*)`. */
  private fileCount(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM files').get() as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  /**
   * Cheap per-query freshness gate. Instead of running the O(N) `fs.stat`
   * sweep in {@link syncIncremental} on every retrieval, compare the adapter's
   * current file COUNT to the indexed record (or, in `SymbolCorpusAdapter`
   * mode, `files`-row) count and only run the full incremental sync when they
   * differ (add/remove drift) or the schema is invalid. Same-count
   * out-of-band content edits are NOT detected here — those are the job of an
   * explicit {@link rebuild} / {@link syncIncremental}.
   */
  async ensureFresh(): Promise<void> {
    if (isSymbolCorpusAdapter(this.adapter)) {
      if (!this.fileSymbolTablesValid()) {
        await this.rebuild();
        return;
      }
      const files = await this.adapter.listFiles();
      if (files.length !== this.fileCount()) await this.syncIncremental();
      return;
    }
    if (!this.schemaIsValid()) {
      await this.rebuild();
      return;
    }
    const files = await this.adapter.listFiles();
    if (files.length !== this.recordCount()) {
      await this.syncIncremental();
    }
  }

  private dropAndRecreateSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS records;
      DROP TABLE IF EXISTS records_fts;
    `);
    this.ensureSchema();
  }

  private dropAndRecreateFileSymbolTables(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS files;
    `);
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
      `INSERT INTO records (id, path, title, body, mtime_ms, content_hash, adapter_meta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
   */
  private async rebuildSymbols(adapter: SymbolCorpusAdapter): Promise<void> {
    this.dropAndRecreateFileSymbolTables();
    const files = await adapter.listFiles();
    const insertFile = this.db.prepare(`INSERT INTO files (file_path, mtime_ms, content_hash) VALUES (?, ?, ?)`);
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const relPath of files) {
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
        insertFile.run(relPath, mtimeMs, contentHash);
        symbols.forEach((symbol, position) => {
          insertSymbol.run(
            `${relPath}#${position}`,
            relPath,
            symbol.name,
            symbol.kind,
            symbol.startLine,
            symbol.endLine,
            symbol.body,
          );
        });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

    const files = await adapter.listFiles();
    const seenPaths = new Set<string>();
    const upsertFile = this.db.prepare(
      `INSERT INTO files (file_path, mtime_ms, content_hash) VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash`,
    );
    const deleteSymbolsForFile = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const insertSymbol = this.db.prepare(
      `INSERT INTO symbols (id, file_path, name, kind, start_line, end_line, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      for (const relPath of files) {
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
            this.db.prepare('UPDATE files SET mtime_ms = ? WHERE file_path = ?').run(st.mtimeMs, relPath);
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
        // Whole-file replace: never attempt per-symbol change detection — an
        // edit shifts the line numbers of every symbol below it anyway.
        deleteSymbolsForFile.run(relPath);
        upsertFile.run(relPath, st.mtimeMs, contentHash);
        symbols.forEach((symbol, position) => {
          insertSymbol.run(
            `${relPath}#${position}`,
            relPath,
            symbol.name,
            symbol.kind,
            symbol.startLine,
            symbol.endLine,
            symbol.body,
          );
        });
      }

      // Drop files (and their symbols) that disappeared.
      const currentFiles = this.db.prepare('SELECT file_path FROM files').all() as Array<Record<string, unknown>>;
      for (const row of currentFiles) {
        const filePath = asString(row.file_path);
        if (seenPaths.has(filePath)) continue;
        this.db.prepare('DELETE FROM files WHERE file_path = ?').run(filePath);
        deleteSymbolsForFile.run(filePath);
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
        `INSERT INTO records (id, path, title, body, mtime_ms, content_hash, adapter_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           title = excluded.title,
           body = excluded.body,
           mtime_ms = excluded.mtime_ms,
           content_hash = excluded.content_hash,
           adapter_meta = excluded.adapter_meta`,
      )
      .run(
        loaded.id,
        loaded.path,
        loaded.title,
        loaded.body,
        loaded.mtimeMs,
        loaded.contentHash,
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

  /** Every derived-index row, decoded back into structured form. */
  allRecords(): StoredRecord[] {
    const rows = this.db
      .prepare('SELECT id, path, title, body, mtime_ms, content_hash, adapter_meta FROM records')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      path: asString(row.path),
      title: asString(row.title),
      body: asString(row.body),
      mtimeMs: asNumber(row.mtime_ms),
      contentHash: asString(row.content_hash),
      adapterMeta: row.adapter_meta == null ? undefined : asString(row.adapter_meta),
    }));
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
    const rows = this.db
      .prepare(
        `SELECT id, bm25(records_fts) AS bm25 FROM records_fts
         WHERE records_fts MATCH ? ORDER BY bm25`,
      )
      .all(match) as Array<Record<string, unknown>>;
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
