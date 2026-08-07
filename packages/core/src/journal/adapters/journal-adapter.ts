import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CorpusIndex, CORPUS_INDEX_DB_FILENAME } from '../engine/index-store.js';
import type { CorpusAdapter, CorpusRecord, IndexHealth, RankedList, StoredRecord } from '../engine/types.js';
import { parseJournalNodeDocument, type JournalNodeDocument } from '../node-codec.js';

/**
 * Journal corpus adapter + journal-specific ranked retrieval.
 *
 * This module is the SOLE owner of every journal concept: topic prefiltering,
 * cross-topic fallback, `superseded` visibility, typed-edge neighbour
 * expansion, tag overlap, and four-digit node ids. The corpus-neutral engine
 * (`../engine/`) knows none of this — it only stores and lexically ranks
 * generic `records`. Two things live here:
 *
 *  1. `JournalCorpusAdapter` — implements the engine's `CorpusAdapter`
 *     contract so `CorpusIndex` can enumerate/decode/index journal node
 *     markdown as generic records (id/path/title/body) and lexically search
 *     them (FTS5/BM25) without knowing what a "journal" is.
 *  2. `JournalIndexStore` — the public store journal callers have always used.
 *     It wraps a `CorpusIndex` for content + lexical search, and keeps a
 *     SEPARATE `journal_meta` table (topic/status/tags/links/description) in
 *     the SAME derived database file, synchronized in lockstep with the
 *     engine's own records via `JournalCorpusAdapter.onDecoded`. The engine
 *     never sees or touches that table.
 */

// ---------------------------------------------------------------------------
// Engine-facing adapter: content + lexical indexing only.
// ---------------------------------------------------------------------------

/** Re-exported under the journal's historical constant name/value — it is now
 * the shared engine's generic derived-database filename. */
export const JOURNAL_INDEX_DB_FILENAME = CORPUS_INDEX_DB_FILENAME;
/** Schema version of the journal's OWN `journal_meta` table, independent of
 * the shared engine's own `records`/`records_fts` schema version. */
export const JOURNAL_INDEX_SCHEMA_VERSION = 1;

export class JournalCorpusAdapter implements CorpusAdapter {
  readonly corpusId = 'journal';
  readonly root: string;
  private readonly decodedMeta = new Map<string, JournalMetaRow>();
  /**
   * JournalIndexStore supplies the persisted metadata view after opening the
   * index. The decoded cache keeps this adapter independently usable by a
   * plain CorpusIndex during a rebuild.
   */
  metadata?: () => Map<string, JournalMetaRow>;
  /**
   * Fired synchronously whenever `decode()` successfully parses a node, so a
   * caller (here, `JournalIndexStore`) can keep a parallel metadata table in
   * lockstep with the engine's own indexing pass without a second full-corpus
   * read. Not part of the `CorpusAdapter` contract — a journal-only hook.
   */
  onDecoded?: (doc: JournalNodeDocument) => void;

  constructor(opts: { journalRoot: string }) {
    this.root = opts.journalRoot;
  }

  private get nodesDir(): string {
    return join(this.root, 'nodes');
  }

  async listFiles(): Promise<string[]> {
    const entries = await readdir(this.nodesDir).catch(() => [] as string[]);
    return entries
      .filter((entry) => entry.endsWith('.md'))
      .sort()
      .map((entry) => join('nodes', entry));
  }

  async decode(relPath: string, raw: string): Promise<CorpusRecord> {
    const parsed = parseJournalNodeDocument(raw, relPath);
    this.decodedMeta.set(parsed.id, {
      nodeId: parsed.id,
      nodePath: parsed.sourcePath,
      topic: parsed.topic,
      status: parsed.status,
      tags: parsed.tags,
      links: parsed.links,
      description: parsed.description,
    });
    this.onDecoded?.(parsed);
    const body = `${parsed.title}\n${parsed.description}\n${parsed.context}\n${parsed.consequences}`.trim();
    return { id: parsed.id, path: relPath, title: parsed.title, body };
  }

  /**
   * The engine owns only generic RRF mechanics. Journal-specific tag overlap
   * and typed-edge expansion are supplied here as ranked lists for it to fuse
   * with lexical order. Passing lexical order in lets the adapter preserve the
   * historical seed rule: lexical hits first, then tag hits, capped at ten.
   */
  signals(tokens: string[], pool: StoredRecord[], lexicalOrder: string[] = []): RankedList[] {
    const metaById = this.metadata?.() ?? this.decodedMeta;
    const poolIds = new Set(pool.map((record) => record.id));
    const tokenSet = new Set(tokens);
    const tagOrder = pool
      .map((record) => ({
        id: record.id,
        overlap: (metaById.get(record.id)?.tags ?? []).filter((tag) => tokenSet.has(tag.toLowerCase())).length,
      }))
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id))
      .map((entry) => entry.id);

    const neighborOrder: string[] = [];
    const seen = new Set<string>();
    const seeds = [...new Set([...lexicalOrder, ...tagOrder])].slice(0, NEIGHBOR_SEED_LIMIT);
    for (const id of seeds) {
      for (const link of metaById.get(id)?.links ?? []) {
        if (!NEIGHBOR_EDGE_TYPES.has(link.type) || !poolIds.has(link.target) || seen.has(link.target)) continue;
        seen.add(link.target);
        neighborOrder.push(link.target);
      }
    }
    return [
      { via: 'tag', order: tagOrder },
      { via: 'neighbor', order: neighborOrder },
    ];
  }
}

// ---------------------------------------------------------------------------
// journal_meta: topic/status/tags/links/description, in a table the engine
// never sees, kept in the same derived database file as `records`.
// ---------------------------------------------------------------------------

interface JournalMetaRow {
  nodeId: string;
  nodePath: string;
  topic: string;
  status: string;
  tags: string[];
  links: { type: string; target: string }[];
  description: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

class JournalMetaStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_meta (
        node_id     TEXT PRIMARY KEY,
        node_path   TEXT NOT NULL,
        topic       TEXT NOT NULL,
        status      TEXT NOT NULL,
        tags        TEXT NOT NULL,
        links       TEXT NOT NULL,
        description TEXT NOT NULL
      );
    `);
  }

  /**
   * Prepared once, reused for every row. Re-preparing per call recompiles the
   * statement on each of N nodes during a rebuild, which measurably regressed
   * the record-latency benchmark gate.
   */
  private upsertStmt: ReturnType<DatabaseSync['prepare']> | null = null;

  upsert(doc: JournalNodeDocument): void {
    this.upsertStmt ??= this.db.prepare(
      `INSERT INTO journal_meta (node_id, node_path, topic, status, tags, links, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           node_path = excluded.node_path,
           topic = excluded.topic,
           status = excluded.status,
           tags = excluded.tags,
           links = excluded.links,
           description = excluded.description`,
    );
    this.upsertStmt.run(
        doc.id,
        doc.sourcePath,
        doc.topic,
        doc.status,
        JSON.stringify(doc.tags),
        JSON.stringify(doc.links),
        doc.description,
      );
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM journal_meta').get() as Record<string, unknown> | undefined;
    return asNumber(row?.n);
  }

  all(): Map<string, JournalMetaRow> {
    const rows = this.db
      .prepare('SELECT node_id, node_path, topic, status, tags, links, description FROM journal_meta')
      .all() as Array<Record<string, unknown>>;
    return new Map(
      rows.map((row) => [
        asString(row.node_id),
        {
          nodeId: asString(row.node_id),
          nodePath: asString(row.node_path),
          topic: asString(row.topic),
          status: asString(row.status),
          tags: JSON.parse(asString(row.tags) || '[]') as string[],
          links: JSON.parse(asString(row.links) || '[]') as { type: string; target: string }[],
          description: asString(row.description),
        },
      ]),
    );
  }

  clear(): void {
    this.db.exec('DELETE FROM journal_meta');
  }

  /** Drop rows that no longer match an indexed record's id/path pair. */
  pruneNotMatching(currentRecords: Map<string, string>): void {
    const rows = this.db.prepare('SELECT node_id, node_path FROM journal_meta').all() as Array<Record<string, unknown>>;
    const del = this.db.prepare('DELETE FROM journal_meta WHERE node_id = ?');
    for (const row of rows) {
      const nodeId = asString(row.node_id);
      if (currentRecords.get(nodeId) !== asString(row.node_path)) del.run(nodeId);
    }
  }
}

// ---------------------------------------------------------------------------
// Public journal index store — same names/semantics journal callers have
// always used, now backed by the corpus-neutral engine plus `journal_meta`.
// ---------------------------------------------------------------------------

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

export type { IndexHealth };

export class JournalIndexStore {
  static async open(opts: { journalRoot: string }): Promise<JournalIndexStore> {
    // Create the journal tree (root + nodes/) so a first `journal_record` /
    // `journal_recall` on a repo with no `.mma/journal` succeeds against an
    // empty corpus.
    await mkdir(join(opts.journalRoot, 'nodes'), { recursive: true });
    const adapter = new JournalCorpusAdapter({ journalRoot: opts.journalRoot });
    const index = await CorpusIndex.open({ root: opts.journalRoot, adapter });
    const metaDb = new DatabaseSync(join(opts.journalRoot, JOURNAL_INDEX_DB_FILENAME));
    metaDb.exec('PRAGMA journal_mode = WAL;');
    metaDb.exec('PRAGMA busy_timeout = 5000;');
    const meta = new JournalMetaStore(metaDb);
    adapter.metadata = () => meta.all();
    const store = new JournalIndexStore(adapter, index, metaDb, meta);
    // Buffer only — see `pendingMeta` for why this must not write to `metaDb`
    // synchronously here (decode() fires inside the engine's own transaction).
    adapter.onDecoded = (doc) => store.pendingMeta.push(doc);
    return store;
  }

  /**
   * `decode()` fires — and therefore `onDecoded` pushes here — WHILE the
   * engine holds an open write transaction on its own connection (inside
   * `rebuild()`/`syncIncremental()`). Writing to `journal_meta` (a SEPARATE
   * connection to the same database file) at that moment contends for the
   * single SQLite writer lock and throws `SQLITE_BUSY`. So `onDecoded` only
   * buffers in memory here; {@link flushPendingMeta} performs the actual
   * writes AFTER the engine call has returned (its transaction committed).
   */
  private pendingMeta: JournalNodeDocument[] = [];

  private constructor(
    private readonly adapter: JournalCorpusAdapter,
    private readonly index: CorpusIndex,
    private readonly metaDb: DatabaseSync,
    private readonly meta: JournalMetaStore,
  ) {}

  /**
   * One transaction for the whole buffer. Without this each upsert runs in its
   * own implicit transaction, so a rebuild of N nodes pays N commits — that
   * alone regressed the record-latency benchmark gate below its 2x floor.
   */
  private flushPendingMeta(): void {
    if (this.pendingMeta.length === 0) return;
    this.metaDb.exec('BEGIN');
    try {
      for (const doc of this.pendingMeta) this.meta.upsert(doc);
      this.metaDb.exec('COMMIT');
    } catch (error) {
      this.metaDb.exec('ROLLBACK');
      throw error;
    }
    this.pendingMeta = [];
  }

  /**
   * Keep `journal_meta` in lockstep with the current node files. Cheap
   * fast path: a matching row/record count skips the per-row diff entirely,
   * mirroring the engine's own count-based freshness gate — no file content
   * is ever read here, only a directory listing.
   */
  private async reconcileMeta(): Promise<void> {
    // Compare COUNTS first, with two cheap `SELECT count(*)` queries. Loading
    // every record here to take its `.length` made this O(corpus) on EVERY
    // record and recall operation, which regressed the record-latency gate.
    // Journal learning 0084: the freshness check must cost less than the read
    // it protects. Only a mismatch pays for the full record list.
    if (this.meta.count() === this.index.recordCount()) return;
    const records = this.index.allRecords();
    this.meta.pruneNotMatching(new Map(records.map((record) => [record.id, record.path])));
  }

  async ensureHealthy(): Promise<IndexHealth> {
    const health = await this.index.ensureHealthy();
    this.flushPendingMeta();
    await this.reconcileMeta();
    return health;
  }

  /**
   * Cheap per-query freshness gate — delegates to the engine's own count-based
   * check (schema invalid → rebuild; file count changed → incremental sync;
   * otherwise a no-op), then reconciles `journal_meta` the same cheap way.
   * Same-count out-of-band content edits are NOT detected here, exactly as
   * before — that is the job of an explicit {@link rebuildIndex} /
   * `syncIndexIncremental`.
   */
  async ensureFresh(): Promise<void> {
    await this.index.ensureFresh();
    this.flushPendingMeta();
    await this.reconcileMeta();
  }

  /** Full rebuild: recreate the schema and re-derive every row from the node files. */
  async rebuildIndex(): Promise<void> {
    this.meta.clear();
    await this.index.rebuild();
    this.flushPendingMeta();
    await this.reconcileMeta();
  }

  async syncIndexIncremental(): Promise<void> {
    await this.index.syncIncremental();
    this.flushPendingMeta();
    await this.reconcileMeta();
  }

  /** Every derived-index row, decoded back into structured form. */
  allDocuments(): IndexedDocument[] {
    const records = this.index.allRecords();
    const metaById = this.meta.all();
    return records.map((record) => {
      const row = metaById.get(record.id);
      return {
        nodeId: record.id,
        nodePath: record.path,
        title: record.title,
        topic: row?.topic ?? '',
        status: row?.status ?? 'adopted',
        tags: row?.tags ?? [],
        links: row?.links ?? [],
        description: row?.description ?? '',
        body: record.body,
      };
    });
  }

  /**
   * FTS5/BM25 lexical probe. Returns node ids best-first (lowest bm25). Empty
   * tokens → empty result.
   */
  lexicalSearch(queryTokens: string[]): LexicalHit[] {
    return this.index.lexicalSearch(queryTokens).map((hit) => ({ nodeId: hit.id, bm25: hit.bm25 }));
  }

  /** Run the engine's RRF against a journal-filtered candidate pool. */
  async search(pool: IndexedDocument[], tokens: string[]): Promise<IndexedDocument[]> {
    const ranked = await this.index.search(tokens, { pool: pool.map((doc) => doc.nodeId) });
    const byId = new Map(this.allDocuments().map((doc) => [doc.nodeId, doc]));
    return ranked.flatMap((record) => {
      const doc = byId.get(record.id);
      return doc ? [doc] : [];
    });
  }

  /** The same journal-owned ranked signals supplied to the engine's RRF. */
  rankedSignals(tokens: string[], pool: IndexedDocument[], lexicalOrder: string[]): RankedList[] {
    const poolIds = new Set(pool.map((doc) => doc.nodeId));
    const records = this.index.allRecords().filter((record) => poolIds.has(record.id));
    return this.adapter.signals(tokens, records, lexicalOrder);
  }

  /** Reflected schema table list (for health/diagnostics tests). */
  async inspectSchema(): Promise<{ tables: string[]; schemaVersion: number }> {
    return this.index.inspectSchema();
  }

  close(): void {
    this.index.close();
    try {
      this.metaDb.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------
// Journal-specific ranked retrieval: topic prefiltering, cross-topic
// fallback, superseded visibility, tag overlap, and typed-edge neighbour
// expansion. This — not the engine — is what makes a "journal search".
// ---------------------------------------------------------------------------

/**
 * A retrieval candidate handed to the recall/record route for retrieve-then-judge.
 * `score` is the fused Reciprocal Rank Fusion score (higher is better).
 * `fallback` marks a cross-topic candidate surfaced only because the in-topic
 * pass produced fewer than {@link MIN_IN_TOPIC} candidates.
 */
export interface JournalCandidate {
  nodeId: string;
  nodePath: string;
  title: string;
  topic: string;
  status: string;
  tags: string[];
  /** One-line node summary (frontmatter `description`). */
  description: string;
  /**
   * Short excerpt of the node's context/consequences body so the LLM can cite
   * evidence without opening the node file.
   */
  snippet: string;
  score: number;
  fallback: boolean;
  matchedVia: string[];
}

/** Max length of the citation snippet excerpt. */
const SNIPPET_MAX = 240;

/**
 * Derive a short citation snippet from the node body. The stored body is
 * `title\ndescription\ncontext\nconsequences`; strip the redundant title +
 * description prefix so the excerpt is the actual context/consequences prose.
 */
function makeSnippet(doc: IndexedDocument): string {
  let rest = doc.body;
  const prefix = `${doc.title}\n${doc.description}\n`;
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  const collapsed = rest.replace(/\s+/g, ' ').trim();
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX)}…` : collapsed;
}

/** Reciprocal Rank Fusion constant. Standard RRF damping. */
const RRF_K = 60;
/** In-topic candidate floor below which the cross-topic fallback pass runs. */
const MIN_IN_TOPIC = 3;
/** Graph-neighbor expansion only follows these edge types. */
const NEIGHBOR_EDGE_TYPES = new Set(['refines', 'depends-on', 'parent', 'supersedes']);
/** How many top lexical/tag hits seed graph-neighbor expansion. */
const NEIGHBOR_SEED_LIMIT = 10;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** RRF contribution for a 1-based rank position. */
function rrf(rank1Based: number): number {
  return 1 / (RRF_K + rank1Based);
}

interface JournalRankedList {
  via: string;
  order: string[]; // node ids, best-first
}

/**
 * Rank a fixed pool of documents against the prompt by fusing three ranked
 * signals with Reciprocal Rank Fusion (k=60):
 *   1. lexical  — FTS5/BM25 order (best-first) restricted to the pool
 *   2. tag      — prompt-token / tag overlap count, descending
 *   3. neighbor — graph neighbours of the top lexical+tag seeds, over
 *                 refines / depends-on / parent / supersession edges
 */
async function rankPool(
  store: JournalIndexStore,
  pool: IndexedDocument[],
  tokens: string[],
): Promise<{ fused: Map<string, { score: number; via: Set<string> }>; engineOrder: Map<string, number> }> {
  const poolIds = new Set(pool.map((doc) => doc.nodeId));
  const byId = new Map(pool.map((doc) => [doc.nodeId, doc]));

  // Signal 1: lexical (FTS5/BM25). Filter global hits down to the pool.
  const lexicalOrder = store
    .lexicalSearch(tokens)
    .map((hit) => hit.nodeId)
    .filter((id) => poolIds.has(id));

  const lists: JournalRankedList[] = [
    { via: 'lexical', order: lexicalOrder },
    ...store.rankedSignals(tokens, pool, lexicalOrder),
  ];

  const fused = new Map<string, { score: number; via: Set<string> }>();
  for (const list of lists) {
    list.order.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, via: new Set<string>() };
      entry.score += rrf(index + 1);
      entry.via.add(list.via);
      fused.set(id, entry);
    });
  }
  const engineOrder = new Map((await store.search(pool, tokens)).map((doc, index) => [doc.nodeId, index]));
  return { fused, engineOrder };
}

function toCandidates(
  ranking: { fused: Map<string, { score: number; via: Set<string> }>; engineOrder: Map<string, number> },
  byId: Map<string, IndexedDocument>,
  fallback: boolean,
): JournalCandidate[] {
  const out: JournalCandidate[] = [];
  for (const [id, entry] of ranking.fused) {
    const doc = byId.get(id);
    if (!doc) continue;
    out.push({
      nodeId: doc.nodeId,
      nodePath: doc.nodePath,
      title: doc.title,
      topic: doc.topic,
      status: doc.status,
      tags: doc.tags,
      description: doc.description,
      snippet: makeSnippet(doc),
      score: entry.score,
      fallback,
      matchedVia: [...entry.via],
    });
  }
  return out.sort(
    (a, b) =>
      (ranking.engineOrder.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER) -
        (ranking.engineOrder.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER) ||
      a.nodeId.localeCompare(b.nodeId),
  );
}

async function search(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string; includeHistory: boolean },
): Promise<JournalCandidate[]> {
  const tokens = tokenize(input.prompt);
  const visible = store
    .allDocuments()
    .filter((doc) => input.includeHistory || doc.status !== 'superseded');
  const byId = new Map(visible.map((doc) => [doc.nodeId, doc]));

  if (!input.topic) {
    const ranking = await rankPool(store, visible, tokens);
    return toCandidates(ranking, byId, false);
  }

  const inTopic = visible.filter((doc) => doc.topic === input.topic);
  const inTopicRanking = await rankPool(store, inTopic, tokens);
  const results = toCandidates(inTopicRanking, byId, false);

  // Cross-topic fallback ONLY when the in-topic pass is thin (< MIN_IN_TOPIC).
  if (results.length >= MIN_IN_TOPIC) return results;

  const present = new Set(results.map((candidate) => candidate.nodeId));
  const crossRanking = await rankPool(store, visible, tokens);
  const crossResults = toCandidates(crossRanking, byId, true).filter(
    (candidate) => !present.has(candidate.nodeId),
  );
  return [...results, ...crossResults];
}

export async function searchCandidatesForRecall(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string; includeHistory: boolean },
): Promise<JournalCandidate[]> {
  await store.ensureHealthy();
  // Cheap count-based freshness gate — skips the O(N) stat sweep in steady state.
  await store.ensureFresh();
  return search(store, input);
}

export async function searchCandidatesForRecord(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string },
): Promise<JournalCandidate[]> {
  await store.ensureHealthy();
  // Cheap count-based freshness gate — skips the O(N) stat sweep in steady state.
  await store.ensureFresh();
  // Record retrieval never surfaces superseded history: dedup targets are live nodes.
  return search(store, { prompt: input.prompt, topic: input.topic, includeHistory: false });
}
