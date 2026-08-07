import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rrfSearch } from './search.js';
import type { CorpusAdapter, IndexHealth, LexicalHit, StoredRecord } from './types.js';

/**
 * Corpus-neutral derived SQLite index.
 *
 * This engine stores and ranks generic "records" supplied by a `CorpusAdapter`
 * (see `./types.ts`) — it has no concept of journals, topics, status,
 * supersession, or typed graph edges. Those all belong to the adapter. The
 * engine only knows: enumerate the adapter's files, decode each into a
 * record, keep an SQLite + FTS5 cache of those records in sync with their
 * source files, and rank a candidate pool by fusing lexical search with
 * whatever extra ranked signal lists the adapter supplies.
 *
 * The adapter's source files are the single source of truth; this index is
 * fully rebuildable from them at any time.
 */

export const CORPUS_INDEX_SCHEMA_VERSION = 1;
export const CORPUS_INDEX_DB_FILENAME = 'index.db';

const REQUIRED_TABLES = ['records', 'records_fts'];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export class CorpusIndex {
  static async open(opts: { root: string; adapter: CorpusAdapter }): Promise<CorpusIndex> {
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
    private readonly adapter: CorpusAdapter,
  ) {}

  private get dbPath(): string {
    return join(this.root, CORPUS_INDEX_DB_FILENAME);
  }

  private openDatabase(): void {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id           TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        mtime_ms     REAL NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        id UNINDEXED,
        title,
        body,
        tokenize = 'porter unicode61'
      );
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

  /**
   * Open + required-table + schema-version check. If the derived cache is
   * missing tables or on the wrong schema version, drop and rebuild it from
   * the authoritative source files. Freshness (new/changed files) is the job
   * of {@link syncIncremental}, not this method.
   */
  async ensureHealthy(): Promise<IndexHealth> {
    if (this.schemaIsValid()) return { state: 'ready' };
    await this.rebuild();
    return { state: 'rebuilt' };
  }

  /** Indexed record count — a single cheap `SELECT count(*)`. */
  private recordCount(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM records').get() as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  /**
   * Cheap per-query freshness gate. Instead of running the O(N) `fs.stat`
   * sweep in {@link syncIncremental} on every retrieval, compare the adapter's
   * current file COUNT to the indexed record count and only run the full
   * incremental sync when they differ (add/remove drift) or the schema is
   * invalid. Same-count out-of-band content edits are NOT detected here —
   * those are the job of an explicit {@link rebuild} / {@link syncIncremental}.
   */
  async ensureFresh(): Promise<void> {
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

  /**
   * Full rebuild: recreate the schema and re-derive every row from the
   * adapter's source files.
   */
  async rebuild(): Promise<void> {
    this.dropAndRecreateSchema();
    const files = await this.adapter.listFiles();
    const insertRecord = this.db.prepare(
      `INSERT INTO records (id, path, title, body, mtime_ms, content_hash) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(`INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const relPath of files) {
        // Tolerate a single unreadable/undecodable EXISTING file: skip-and-warn
        // so one malformed source file can't crash the whole index rebuild.
        let loaded: StoredRecord;
        try {
          loaded = await this.loadFile(relPath);
        } catch (error) {
          console.warn(
            `[corpus-engine:${this.adapter.corpusId}] skipping unreadable/undecodable record ${relPath}: ${(error as Error).message}`,
          );
          continue;
        }
        insertRecord.run(loaded.id, loaded.path, loaded.title, loaded.body, loaded.mtimeMs, loaded.contentHash);
        insertFts.run(loaded.id, loaded.title, loaded.body);
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
   * every retrieval.
   */
  async syncIncremental(): Promise<void> {
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

    const files = await this.adapter.listFiles();
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
          const record = await this.adapter.decode(relPath, raw);
          loaded = { ...record, mtimeMs: st.mtimeMs, contentHash };
        } catch (error) {
          console.warn(
            `[corpus-engine:${this.adapter.corpusId}] skipping unreadable/undecodable record ${relPath}: ${(error as Error).message}`,
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

  private upsertRecord(loaded: StoredRecord): void {
    this.db
      .prepare(
        `INSERT INTO records (id, path, title, body, mtime_ms, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           path = excluded.path,
           title = excluded.title,
           body = excluded.body,
           mtime_ms = excluded.mtime_ms,
           content_hash = excluded.content_hash`,
      )
      .run(loaded.id, loaded.path, loaded.title, loaded.body, loaded.mtimeMs, loaded.contentHash);
    this.db.prepare('DELETE FROM records_fts WHERE id = ?').run(loaded.id);
    this.db.prepare('INSERT INTO records_fts (id, title, body) VALUES (?, ?, ?)').run(loaded.id, loaded.title, loaded.body);
  }

  private deleteRecord(id: string): void {
    this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM records_fts WHERE id = ?').run(id);
  }

  private async loadFile(relPath: string): Promise<StoredRecord> {
    const fullPath = join(this.root, relPath);
    const raw = await readFile(fullPath, 'utf8');
    const st = await stat(fullPath);
    const contentHash = createHash('sha256').update(raw).digest('hex');
    const record = await this.adapter.decode(relPath, raw);
    return { ...record, mtimeMs: st.mtimeMs, contentHash };
  }

  /** Every derived-index row, decoded back into structured form. */
  allRecords(): StoredRecord[] {
    const rows = this.db
      .prepare('SELECT id, path, title, body, mtime_ms, content_hash FROM records')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row.id),
      path: asString(row.path),
      title: asString(row.title),
      body: asString(row.body),
      mtimeMs: asNumber(row.mtime_ms),
      contentHash: asString(row.content_hash),
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
