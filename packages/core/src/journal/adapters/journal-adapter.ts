import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CorpusIndex, CORPUS_INDEX_DB_FILENAME, CORPUS_INDEX_SCHEMA_VERSION } from '../engine/index-store.js';
import type { CorpusAdapter, CorpusRecord, IndexHealth, RankedList, StoredRecordMeta } from '../engine/types.js';
import { parseJournalNodeDocument } from '../node-codec.js';

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
 *     them (FTS5/BM25) without knowing what a "journal" is. Journal-only
 *     metadata (topic/status/tags/links/description) rides along as a JSON
 *     string in the record's opaque `adapterMeta` field — persisted by the
 *     engine in the SAME row, SAME statement, and SAME transaction as the
 *     record itself. There is no second table and no second database
 *     connection: the engine never parses `adapterMeta`, it only stores and
 *     returns it.
 *  2. `JournalIndexStore` — the public store journal callers have always
 *     used. It wraps a `CorpusIndex` for content, lexical search, and
 *     metadata, deserializing each record's `adapterMeta` back into journal
 *     metadata on read.
 */

// ---------------------------------------------------------------------------
// Engine-facing adapter: content + lexical indexing, plus opaque metadata.
// ---------------------------------------------------------------------------

/** Re-exported under the journal's historical constant name/value — it is now
 * the shared engine's generic derived-database filename. */
export const JOURNAL_INDEX_DB_FILENAME = CORPUS_INDEX_DB_FILENAME;

/** Re-exported under the journal's historical constant name/value — it is now
 * the shared engine's generic derived-database schema version. */
export const JOURNAL_INDEX_SCHEMA_VERSION = CORPUS_INDEX_SCHEMA_VERSION;

/** Journal-only metadata, serialized into a record's opaque `adapterMeta`. */
interface JournalAdapterMeta {
  topic: string;
  status: string;
  tags: string[];
  links: { type: string; target: string }[];
  description: string;
}

function parseAdapterMeta(raw: string | undefined): JournalAdapterMeta | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as JournalAdapterMeta;
  } catch {
    return undefined;
  }
}

export class JournalCorpusAdapter implements CorpusAdapter {
  readonly corpusId = 'journal';
  readonly root: string;

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
    const meta: JournalAdapterMeta = {
      topic: parsed.topic,
      status: parsed.status,
      tags: parsed.tags,
      links: parsed.links,
      description: parsed.description,
    };
    const body = `${parsed.title}\n${parsed.description}\n${parsed.context}\n${parsed.consequences}`.trim();
    return { id: parsed.id, path: relPath, title: parsed.title, body, adapterMeta: JSON.stringify(meta) };
  }

  /**
   * The engine owns only generic RRF mechanics. Journal-specific tag overlap
   * and typed-edge expansion are supplied here as ranked lists for it to fuse
   * with lexical order. Passing lexical order in lets the adapter preserve the
   * historical seed rule: lexical hits first, then tag hits, capped at ten.
   * `pool` records already carry their own `adapterMeta` — no separate lookup.
   * `pool` is metadata-only (no `body`): every signal here reads only `id`
   * and `adapterMeta`, never record text.
   */
  signals(tokens: string[], pool: StoredRecordMeta[], lexicalOrder: string[] = []): RankedList[] {
    const poolIds = new Set(pool.map((record) => record.id));
    const metaById = new Map(pool.map((record) => [record.id, parseAdapterMeta(record.adapterMeta)]));
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
// Public journal index store — same names/semantics journal callers have
// always used, now backed entirely by the corpus-neutral engine.
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

/**
 * An {@link IndexedDocument} projection WITHOUT `body` — everything ranking
 * (topic prefilter, tag overlap, graph-neighbour expansion, RRF fusion)
 * needs, and nothing more. `body` is fetched separately, only for the
 * records that survive ranking (see {@link JournalIndexStore.documentsBodyByIds}).
 */
export type IndexedDocumentMeta = Omit<IndexedDocument, 'body'>;

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
    return new JournalIndexStore(adapter, index);
  }

  private constructor(
    private readonly adapter: JournalCorpusAdapter,
    private readonly index: CorpusIndex,
  ) {}

  async ensureHealthy(): Promise<IndexHealth> {
    return this.index.ensureHealthy();
  }

  /**
   * Cheap per-query freshness gate — delegates to the engine's own count-based
   * check (schema invalid → rebuild; file count changed → incremental sync;
   * otherwise a no-op).
   */
  async ensureFresh(): Promise<void> {
    await this.index.ensureFresh();
  }

  /** Full rebuild: recreate the schema and re-derive every row from the node files. */
  async rebuildIndex(): Promise<void> {
    await this.index.rebuild();
  }

  async syncIndexIncremental(): Promise<void> {
    await this.index.syncIncremental();
  }

  /**
   * Every derived-index row, decoded back into structured form. Journal
   * metadata is deserialized from each record's own `adapterMeta` field —
   * there is no separate metadata table or connection to join against.
   */
  allDocuments(): IndexedDocument[] {
    const records = this.index.allRecords();
    return records.map((record) => {
      const meta = parseAdapterMeta(record.adapterMeta);
      return {
        nodeId: record.id,
        nodePath: record.path,
        title: record.title,
        topic: meta?.topic ?? '',
        status: meta?.status ?? 'adopted',
        tags: meta?.tags ?? [],
        links: meta?.links ?? [],
        description: meta?.description ?? '',
        body: record.body,
      };
    });
  }

  /**
   * Every derived-index row's metadata ONLY — same fields as
   * {@link allDocuments} minus `body`. This is the shape ranking (topic
   * prefilter, tag overlap, graph-neighbour expansion, RRF fusion) actually
   * needs; it never touches a record's body text. Use this on the query path
   * instead of {@link allDocuments}, whose `body` projection exists for
   * callers that need node text (e.g. {@link documentsBodyByIds}, or a
   * direct caller like the reindex CLI's node count).
   */
  allDocumentsMeta(): IndexedDocumentMeta[] {
    const records = this.index.allRecordsMeta();
    return records.map((record) => {
      const meta = parseAdapterMeta(record.adapterMeta);
      return {
        nodeId: record.id,
        nodePath: record.path,
        title: record.title,
        topic: meta?.topic ?? '',
        status: meta?.status ?? 'adopted',
        tags: meta?.tags ?? [],
        links: meta?.links ?? [],
        description: meta?.description ?? '',
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

  /**
   * Body text for exactly the given node ids — the ONE targeted lookup a
   * query runs, once ranking has already narrowed the corpus down to the
   * ids it will actually return. Never call this with more ids than a query
   * is about to return; that would recreate the whole-corpus body read this
   * method exists to avoid.
   */
  documentsBodyByIds(nodeIds: string[]): Map<string, string> {
    const records = this.index.recordsByIds([...new Set(nodeIds)]);
    return new Map(records.map((record) => [record.id, record.body]));
  }

  /**
   * The same journal-owned ranked signals supplied to the engine's RRF,
   * built directly from the already-in-memory metadata `pool` — no index
   * read. `pool` already carries each document's decoded topic/status/tags/
   * links, so those are simply re-serialized into the opaque `adapterMeta`
   * string shape {@link JournalCorpusAdapter.signals} expects, rather than
   * re-fetched from the database.
   */
  rankedSignals(tokens: string[], pool: IndexedDocumentMeta[], lexicalOrder: string[]): RankedList[] {
    const records: StoredRecordMeta[] = pool.map((doc) => {
      const meta: JournalAdapterMeta = {
        topic: doc.topic,
        status: doc.status,
        tags: doc.tags,
        links: doc.links,
        description: doc.description,
      };
      return {
        id: doc.nodeId,
        path: doc.nodePath,
        title: doc.title,
        mtimeMs: 0,
        contentHash: '',
        adapterMeta: JSON.stringify(meta),
      };
    });
    return this.adapter.signals(tokens, records, lexicalOrder);
  }

  /** Reflected schema table list (for health/diagnostics tests). */
  async inspectSchema(): Promise<{ tables: string[]; schemaVersion: number }> {
    return this.index.inspectSchema();
  }

  close(): void {
    this.index.close();
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
 * A {@link JournalCandidate} before its body-derived `snippet` is attached —
 * every candidate field ranking can produce from metadata alone. `search()`
 * builds this list first, then fetches `body` for exactly these surviving
 * ids ({@link JournalIndexStore.documentsBodyByIds}) and appends `snippet`
 * in one final pass, rather than carrying every visible document's body
 * through ranking.
 */
type JournalCandidateMeta = Omit<JournalCandidate, 'snippet'>;

/**
 * Derive a short citation snippet from a node's body. The stored body is
 * `title\ndescription\ncontext\nconsequences`; strip the redundant title +
 * description prefix so the excerpt is the actual context/consequences prose.
 */
function makeSnippet(title: string, description: string, body: string): string {
  let rest = body;
  const prefix = `${title}\n${description}\n`;
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
 *
 * `pool` is metadata-only — this never reads or ranks a record's body text.
 * This is the SOLE ranking pass for a pool: it is the fused RRF score itself
 * (not a second call into the engine's own RRF) that determines final order
 * in {@link toCandidateMetas}, so a pool's lexical/tag/neighbor signals are
 * computed exactly once.
 */
function rankPool(
  store: JournalIndexStore,
  pool: IndexedDocumentMeta[],
  tokens: string[],
): Map<string, { score: number; via: Set<string> }> {
  const poolIds = new Set(pool.map((doc) => doc.nodeId));

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
  return fused;
}

/**
 * Resolve a pool's fused RRF scores into candidates, best-first (score
 * descending, node id ascending as a stable tie-break) — no body/snippet
 * yet, see {@link JournalCandidateMeta}.
 */
function toCandidateMetas(
  fused: Map<string, { score: number; via: Set<string> }>,
  byId: Map<string, IndexedDocumentMeta>,
  fallback: boolean,
): JournalCandidateMeta[] {
  const out: JournalCandidateMeta[] = [];
  for (const [id, entry] of fused) {
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
      score: entry.score,
      fallback,
      matchedVia: [...entry.via],
    });
  }
  return out.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
}

async function search(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string; includeHistory: boolean },
): Promise<JournalCandidate[]> {
  const tokens = tokenize(input.prompt);
  const visible = store
    .allDocumentsMeta()
    .filter((doc) => input.includeHistory || doc.status !== 'superseded');
  const byId = new Map(visible.map((doc) => [doc.nodeId, doc]));

  let metas: JournalCandidateMeta[];
  if (!input.topic) {
    metas = toCandidateMetas(rankPool(store, visible, tokens), byId, false);
  } else {
    const inTopic = visible.filter((doc) => doc.topic === input.topic);
    const results = toCandidateMetas(rankPool(store, inTopic, tokens), byId, false);

    // Cross-topic fallback ONLY when the in-topic pass is thin (< MIN_IN_TOPIC).
    if (results.length >= MIN_IN_TOPIC) {
      metas = results;
    } else {
      const present = new Set(results.map((candidate) => candidate.nodeId));
      const crossResults = toCandidateMetas(rankPool(store, visible, tokens), byId, true).filter(
        (candidate) => !present.has(candidate.nodeId),
      );
      metas = [...results, ...crossResults];
    }
  }

  // Body is fetched ONCE, only for the ids that survived ranking — never for
  // the whole visible pool.
  const bodyById = store.documentsBodyByIds(metas.map((meta) => meta.nodeId));
  return metas.map((meta) => ({
    ...meta,
    snippet: makeSnippet(meta.title, meta.description, bodyById.get(meta.nodeId) ?? ''),
  }));
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
