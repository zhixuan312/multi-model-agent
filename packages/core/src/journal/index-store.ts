import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseJournalNodeDocument } from './node-codec.js';

/**
 * Derived SQLite cache for the journal corpus.
 *
 * The markdown nodes under `<journalRoot>/nodes/` are the single source of
 * truth; this index is fully rebuildable from them at any time. It exists only
 * to make lexical retrieval (FTS5/BM25) and graph expansion fast without the
 * LLM scanning the corpus.
 */

export const JOURNAL_INDEX_SCHEMA_VERSION = 2;
export const JOURNAL_INDEX_DB_FILENAME = 'index.db';

/** A single lexical link edge as stored in the derived index. */
export interface IndexedLink {
  type: string;
  target: string;
}

/** One derived-index row, decoded back into structured form. */
export interface IndexedDocument {
  nodeId: string;
  nodePath: string;
  title: string;
  topic: string;
  status: string;
  tags: string[];
  links: IndexedLink[];
  /** One-line node summary from frontmatter `description`. */
  description: string;
  /**
   * Concatenated `title\ndescription\ncontext\nconsequences`, used for FTS
   * indexing and for deriving a citation snippet (context/consequences excerpt).
   */
  body: string;
}

/** Result of a lexical FTS5 probe: node ids ordered best-first (lowest bm25). */
export interface LexicalHit {
  nodeId: string;
  bm25: number;
}

/** Outcome of a health probe. `rebuilt` means a corrupt/stale schema was recreated. */
export interface IndexHealth {
  state: 'ready' | 'rebuilt';
}

const REQUIRED_TABLES = ['documents', 'documents_fts', 'vectors_meta'];

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export class JournalIndexStore {
  static async open(opts: { journalRoot: string }): Promise<JournalIndexStore> {
    const store = new JournalIndexStore(opts.journalRoot);
    // First-use bootstrap: `new DatabaseSync(<journalRoot>/index.db)` throws
    // ENOENT/SQLITE_CANTOPEN when the parent dir does not exist yet. Create the
    // journal tree (root + nodes/) so a first `journal_record` / `journal_recall`
    // on a repo with no `.mma/journal` succeeds against an empty corpus.
    await mkdir(join(opts.journalRoot, 'nodes'), { recursive: true });
    store.openDatabase();
    return store;
  }

  private db!: DatabaseSync;

  private constructor(private readonly journalRoot: string) {}

  private get dbPath(): string {
    return join(this.journalRoot, JOURNAL_INDEX_DB_FILENAME);
  }

  private get nodesDir(): string {
    return join(this.journalRoot, 'nodes');
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
      CREATE TABLE IF NOT EXISTS documents (
        node_id      TEXT PRIMARY KEY,
        node_path    TEXT NOT NULL,
        title        TEXT NOT NULL,
        topic        TEXT NOT NULL,
        status       TEXT NOT NULL,
        tags         TEXT NOT NULL,
        links        TEXT NOT NULL,
        description  TEXT NOT NULL,
        body         TEXT NOT NULL,
        mtime_ms     REAL NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        node_id UNINDEXED,
        title,
        tags,
        body,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS vectors_meta (
        node_id    TEXT PRIMARY KEY,
        model      TEXT,
        dim        INTEGER,
        created_at TEXT
      );
    `);
    this.db.exec(`PRAGMA user_version = ${JOURNAL_INDEX_SCHEMA_VERSION};`);
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
    if (this.schemaVersion() !== JOURNAL_INDEX_SCHEMA_VERSION) return false;
    return REQUIRED_TABLES.every((name) => tables.includes(name));
  }

  /**
   * Open + required-table + schema-version check. If the derived cache is
   * missing tables or on the wrong schema version, drop and rebuild it from the
   * authoritative node files. Freshness (new/changed files) is the job of
   * {@link syncIndexIncremental}, not this method.
   */
  async ensureHealthy(): Promise<IndexHealth> {
    if (this.schemaIsValid()) return { state: 'ready' };
    await this.rebuildIndex();
    return { state: 'rebuilt' };
  }

  /** Indexed document count — a single cheap `SELECT count(*)`. */
  private documentCount(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM documents').get() as
      | Record<string, unknown>
      | undefined;
    return asNumber(row?.n);
  }

  /**
   * Cheap per-query freshness gate. Instead of running the O(N) `fs.stat` sweep
   * in {@link syncIndexIncremental} on every retrieval, compare the node-file
   * COUNT (a single `readdir`) to the indexed document count (a single
   * `SELECT count(*)`) and only run the full incremental sync when they differ
   * (add/remove drift) or the schema is invalid/empty-after-rebuild.
   *
   * Correctness for the engine's own writes: create / refine / supersede all
   * ADD a node → the count changes → drift detected → full sync (which also
   * re-syncs the in-place status flip a supersede makes to its target). A merge
   * adds no node and changes no retrievable content → correctly skipped.
   * Same-count out-of-band content edits are NOT detected here — those are the
   * job of `mma journal reindex` ({@link rebuildIndex}) / an explicit
   * {@link syncIndexIncremental}.
   */
  async ensureFresh(): Promise<void> {
    if (!this.schemaIsValid()) {
      await this.rebuildIndex();
      return;
    }
    const fileCount = (await this.listNodeFiles()).length;
    if (fileCount !== this.documentCount()) {
      await this.syncIndexIncremental();
    }
  }

  private dropAndRecreateSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS documents;
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS vectors_meta;
    `);
    this.ensureSchema();
  }

  /**
   * Full rebuild: recreate the schema and re-derive every row from the node
   * files. This is the CLI reindex entry point (I-7) and the corruption
   * recovery path.
   */
  async rebuildIndex(): Promise<void> {
    this.dropAndRecreateSchema();
    const files = await this.listNodeFiles();
    const insertDoc = this.db.prepare(
      `INSERT INTO documents (node_id, node_path, title, topic, status, tags, links, description, body, mtime_ms, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO documents_fts (node_id, title, tags, body) VALUES (?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const file of files) {
        // Tolerate a single unparseable EXISTING node: skip-and-warn so one malformed
        // legacy file can't crash the whole index rebuild. New-node writes still throw.
        let loaded: LoadedNode;
        try {
          loaded = await this.loadFile(file);
        } catch (error) {
          console.warn(`[journal] skipping unparseable node ${join('nodes', file)}: ${(error as Error).message}`);
          continue;
        }
        insertDoc.run(
          loaded.nodeId,
          loaded.nodePath,
          loaded.title,
          loaded.topic,
          loaded.status,
          JSON.stringify(loaded.tags),
          JSON.stringify(loaded.links),
          loaded.description,
          loaded.body,
          loaded.mtimeMs,
          loaded.contentHash,
        );
        insertFts.run(loaded.nodeId, loaded.title, loaded.tags.join(' '), loaded.body);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Incremental sync keyed by node path + mtime + content hash. Only files whose
   * mtime AND content hash differ from the stored row are re-parsed and upserted;
   * files that vanished are dropped. Cheap enough to run before every retrieval.
   */
  async syncIndexIncremental(): Promise<void> {
    if (!this.schemaIsValid()) {
      await this.rebuildIndex();
      return;
    }
    const existing = new Map<string, { mtimeMs: number; contentHash: string }>();
    const rows = this.db
      .prepare('SELECT node_path, mtime_ms, content_hash FROM documents')
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      existing.set(asString(row.node_path), {
        mtimeMs: asNumber(row.mtime_ms),
        contentHash: asString(row.content_hash),
      });
    }

    const files = await this.listNodeFiles();
    const seenPaths = new Set<string>();

    this.db.exec('BEGIN');
    try {
      for (const file of files) {
        const nodePath = join('nodes', file);
        seenPaths.add(nodePath);
        const fullPath = join(this.nodesDir, file);
        const st = await stat(fullPath);
        const prior = existing.get(nodePath);
        if (prior && prior.mtimeMs === st.mtimeMs) continue; // unchanged by mtime

        const raw = await readFile(fullPath, 'utf8');
        const contentHash = createHash('sha256').update(raw).digest('hex');
        if (prior && prior.contentHash === contentHash) {
          // Content identical, only mtime drifted — refresh mtime, skip re-parse.
          this.db
            .prepare('UPDATE documents SET mtime_ms = ? WHERE node_path = ?')
            .run(st.mtimeMs, nodePath);
          continue;
        }
        // Tolerate a single unparseable EXISTING node: skip-and-warn so one malformed
        // legacy file can't crash the incremental sync. New-node writes still throw.
        let loaded: LoadedNode;
        try {
          loaded = this.decodeRaw(raw, nodePath, st.mtimeMs, contentHash);
        } catch (error) {
          console.warn(`[journal] skipping unparseable node ${nodePath}: ${(error as Error).message}`);
          continue;
        }
        this.upsertDocument(loaded);
      }

      // Drop rows whose file disappeared.
      const currentRows = this.db
        .prepare('SELECT node_id, node_path FROM documents')
        .all() as Array<Record<string, unknown>>;
      for (const row of currentRows) {
        const nodePath = asString(row.node_path);
        if (!seenPaths.has(nodePath)) this.deleteDocument(asString(row.node_id));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private upsertDocument(loaded: LoadedNode): void {
    this.db
      .prepare(
        `INSERT INTO documents (node_id, node_path, title, topic, status, tags, links, description, body, mtime_ms, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           node_path = excluded.node_path,
           title = excluded.title,
           topic = excluded.topic,
           status = excluded.status,
           tags = excluded.tags,
           links = excluded.links,
           description = excluded.description,
           body = excluded.body,
           mtime_ms = excluded.mtime_ms,
           content_hash = excluded.content_hash`,
      )
      .run(
        loaded.nodeId,
        loaded.nodePath,
        loaded.title,
        loaded.topic,
        loaded.status,
        JSON.stringify(loaded.tags),
        JSON.stringify(loaded.links),
        loaded.description,
        loaded.body,
        loaded.mtimeMs,
        loaded.contentHash,
      );
    this.db.prepare('DELETE FROM documents_fts WHERE node_id = ?').run(loaded.nodeId);
    this.db
      .prepare('INSERT INTO documents_fts (node_id, title, tags, body) VALUES (?, ?, ?, ?)')
      .run(loaded.nodeId, loaded.title, loaded.tags.join(' '), loaded.body);
  }

  private deleteDocument(nodeId: string): void {
    this.db.prepare('DELETE FROM documents WHERE node_id = ?').run(nodeId);
    this.db.prepare('DELETE FROM documents_fts WHERE node_id = ?').run(nodeId);
  }

  private async listNodeFiles(): Promise<string[]> {
    const entries = await readdir(this.nodesDir).catch(() => [] as string[]);
    return entries.filter((entry) => entry.endsWith('.md')).sort();
  }

  private async loadFile(file: string): Promise<LoadedNode> {
    const nodePath = join('nodes', file);
    const fullPath = join(this.nodesDir, file);
    const raw = await readFile(fullPath, 'utf8');
    const st = await stat(fullPath);
    const contentHash = createHash('sha256').update(raw).digest('hex');
    return this.decodeRaw(raw, nodePath, st.mtimeMs, contentHash);
  }

  private decodeRaw(raw: string, nodePath: string, mtimeMs: number, contentHash: string): LoadedNode {
    const parsed = parseJournalNodeDocument(raw, nodePath);
    return {
      nodeId: parsed.id,
      nodePath: parsed.sourcePath,
      title: parsed.title,
      topic: parsed.topic,
      status: parsed.status,
      tags: parsed.tags,
      links: parsed.links,
      description: parsed.description,
      body: `${parsed.title}\n${parsed.description}\n${parsed.context}\n${parsed.consequences}`.trim(),
      mtimeMs,
      contentHash,
    };
  }

  /** Every derived-index row, decoded back into structured form. */
  allDocuments(): IndexedDocument[] {
    const rows = this.db
      .prepare('SELECT node_id, node_path, title, topic, status, tags, links, description, body FROM documents')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      nodeId: asString(row.node_id),
      nodePath: asString(row.node_path),
      title: asString(row.title),
      topic: asString(row.topic),
      status: asString(row.status),
      tags: JSON.parse(asString(row.tags) || '[]') as string[],
      links: JSON.parse(asString(row.links) || '[]') as IndexedLink[],
      description: asString(row.description),
      body: asString(row.body),
    }));
  }

  /**
   * FTS5/BM25 lexical probe. `queryTokens` are OR-joined and phrase-quoted so
   * FTS operators embedded in node text stay inert. Returns node ids best-first
   * (lowest bm25). Empty tokens → empty result.
   */
  lexicalSearch(queryTokens: string[]): LexicalHit[] {
    const clean = queryTokens
      .map((token) => token.replace(/"/g, '').trim())
      .filter((token) => token.length > 0);
    if (clean.length === 0) return [];
    const match = clean.map((token) => `"${token}"`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT node_id, bm25(documents_fts) AS bm25 FROM documents_fts
         WHERE documents_fts MATCH ? ORDER BY bm25`,
      )
      .all(match) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ nodeId: asString(row.node_id), bm25: asNumber(row.bm25) }));
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

interface LoadedNode extends IndexedDocument {
  mtimeMs: number;
  contentHash: string;
}
