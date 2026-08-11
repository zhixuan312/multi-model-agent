import { mkdir, readdir, stat } from 'node:fs/promises';
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
 *     them (FTS5/BM25) without knowing what a "journal" is. `topic` and
 *     `status` are supplied as the engine's real, INDEXED `topic`/`status`
 *     columns (schema version 3) — so a query can prefilter/scope candidates
 *     in SQL. Everything else journal-only (tags/links/description) rides
 *     along as a JSON string in the record's opaque `adapterMeta` field —
 *     persisted by the engine in the SAME row, SAME statement, and SAME
 *     transaction as the record itself. There is no second table and no
 *     second database connection: the engine never parses `adapterMeta`, it
 *     only stores and returns it.
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

/**
 * Journal-only metadata, serialized into a record's opaque `adapterMeta`.
 * `topic` and `status` are NOT here — schema version 3 promoted both to real,
 * indexed columns on the engine's `records` table (see
 * `../engine/index-store.ts`'s `ensureSchema`) so a query can prefilter and
 * scope candidates in SQL. `adapterMeta` still carries everything the engine
 * has no reason to index: tags, links, and the frontmatter description.
 */
interface JournalAdapterMeta {
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

  /**
   * Modification time of the `nodes/` directory itself — updates whenever a
   * node file is added or removed (standard filesystem behavior), so the
   * engine can use it as a cheap, exact "did anything change" pre-check
   * before paying for a full {@link listFiles} enumeration on every query
   * (see `CorpusIndex.ensureFreshRecords`). `null` if the directory is
   * unreadable (e.g. not yet created) — the engine falls back to its
   * unconditional `listFiles()` check in that case.
   */
  async rootMtimeMs(): Promise<number | null> {
    try {
      return (await stat(this.nodesDir)).mtimeMs;
    } catch {
      return null;
    }
  }

  async decode(relPath: string, raw: string): Promise<CorpusRecord> {
    const parsed = parseJournalNodeDocument(raw, relPath);
    const meta: JournalAdapterMeta = {
      tags: parsed.tags,
      links: parsed.links,
      description: parsed.description,
    };
    const body = `${parsed.title}\n${parsed.description}\n${parsed.context}\n${parsed.consequences}`.trim();
    return {
      id: parsed.id,
      path: relPath,
      title: parsed.title,
      body,
      topic: parsed.topic,
      status: parsed.status,
      adapterMeta: JSON.stringify(meta),
    };
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
   * Decode one engine record's metadata fields into an {@link
   * IndexedDocumentMeta}: `topic`/`status` come straight off the record's own
   * (real, indexed) columns; `tags`/`links`/`description` are deserialized
   * from its `adapterMeta` JSON — there is no separate metadata table or
   * connection to join against. Shared by every read path so this mapping is
   * written once.
   */
  private toIndexedDocumentMeta(record: StoredRecordMeta): IndexedDocumentMeta {
    const meta = parseAdapterMeta(record.adapterMeta);
    return {
      nodeId: record.id,
      nodePath: record.path,
      title: record.title,
      topic: record.topic ?? '',
      status: record.status || 'adopted',
      tags: meta?.tags ?? [],
      links: meta?.links ?? [],
      description: meta?.description ?? '',
    };
  }

  /** Every derived-index row, decoded back into structured form. */
  allDocuments(): IndexedDocument[] {
    return this.index.allRecords().map((record) => ({ ...this.toIndexedDocumentMeta(record), body: record.body }));
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
    return this.index.allRecordsMeta().map((record) => this.toIndexedDocumentMeta(record));
  }

  /**
   * SQL-BOUNDED candidate metadata: lexical FTS5/BM25 match, scoped to an
   * optional exact `topic` and status visibility, capped at `opts.limit` rows
   * — the candidate-bounded counterpart to {@link allDocumentsMeta}. Returned
   * in bm25 (lexical relevance) order, best match first. This is the read a
   * per-query candidate search should use: unlike {@link allDocumentsMeta},
   * its row count never grows with corpus or topic size.
   */
  candidateDocumentsMeta(opts: { tokens: string[]; topic?: string; includeHistory: boolean; limit: number }): IndexedDocumentMeta[] {
    return this.index.candidateRecordsMeta(opts).map((record) => this.toIndexedDocumentMeta(record));
  }

  /**
   * Metadata for exactly the given node ids — used for BOUNDED
   * graph-neighbour target lookups (a handful of specific link targets a
   * candidate pool's seed documents point to, capped by seeds x edges), never
   * for a whole-corpus read. Unmatched ids are silently omitted.
   */
  documentsMetaByIds(nodeIds: string[]): IndexedDocumentMeta[] {
    return this.index.recordsMetaByIds([...new Set(nodeIds)]).map((record) => this.toIndexedDocumentMeta(record));
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
        topic: doc.topic,
        status: doc.status,
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
 * Max length of the preview `description`. Frontmatter `description` is meant
 * to be one line, but nothing enforces that, and an unbounded field multiplied
 * by the candidate count is what pushes an assembled recall prompt past a
 * model's input limit. Bounded here for the same reason {@link SNIPPET_MAX}
 * bounds the excerpt — the worker reads the node itself when it needs the
 * whole thing.
 */
const DESCRIPTION_MAX = 300;

/**
 * Byte budget for the assembled candidate previews handed to a recall worker,
 * roughly 30k tokens at 4 bytes per token.
 *
 * This is a budget, NOT a relevance cap. Previews are deliberately cheap so
 * the budget admits hundreds of them: the worker selects from a wide field and
 * then OPENS the nodes it judges relevant (`nodePath` is on every candidate,
 * and `journal_recall` runs read-only), so depth comes from targeted reads
 * rather than from a larger prompt. A fixed top-K would instead drop relevant
 * nodes before the worker ever sees they exist.
 *
 * When the budget does bind, the count of dropped candidates travels with the
 * payload so the answer can state its own coverage. Silent truncation is the
 * one outcome this must never produce.
 */
const RECALL_PREVIEW_BUDGET_BYTES = 120_000;

/** Recall retrieval result: previews that fit the budget, plus what did not. */
export interface RecallCandidateSet {
  candidates: JournalCandidate[];
  /** Ranked candidates dropped by {@link RECALL_PREVIEW_BUDGET_BYTES}. 0 when all fit. */
  withheld: number;
  /** Total ranked candidates before the budget was applied. */
  totalRanked: number;
}

/** Trim a preview field to `max`, marking the cut so the worker knows to read the node. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Fill the preview budget best-first. Ranking already sorted by fused score, so
 * dropping from the tail drops the least relevant candidates — and the caller
 * is told how many, never left to assume the set was complete.
 */
function applyPreviewBudget(ranked: JournalCandidate[], budgetBytes: number): RecallCandidateSet {
  const kept: JournalCandidate[] = [];
  let used = 0;
  for (const candidate of ranked) {
    const cost = JSON.stringify(candidate).length;
    // Always admit the top candidate: a single oversized node must not produce
    // an empty answer.
    if (kept.length > 0 && used + cost > budgetBytes) break;
    kept.push(candidate);
    used += cost;
  }
  return { candidates: kept, withheld: ranked.length - kept.length, totalRanked: ranked.length };
}

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
/**
 * Upper bound on how many rows a single candidate query pulls from SQL (see
 * {@link JournalIndexStore.candidateDocumentsMeta}). This is what makes a
 * query CANDIDATE-BOUNDED rather than corpus-bounded: the row count a query
 * materializes never grows with corpus or topic size, only with how many
 * distinct documents can plausibly matter for one prompt. Generous relative
 * to how concentrated a real lexical match set is (a query's rare/distinctive
 * tokens match a small fraction of the corpus; only very common tokens could
 * approach this cap, and bm25 ordering keeps the genuinely relevant rows at
 * the front regardless).
 */
const CANDIDATE_CAP = 200;

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

/** Prompt-token / tag overlap count, descending — used both to pick
 * graph-neighbor seeds (see {@link rankCandidates}) and, via {@link
 * JournalIndexStore.rankedSignals}, as one of the fused RRF signals. Pure and
 * cheap: it only ever runs over an already-bounded candidate pool (at most
 * {@link CANDIDATE_CAP} documents), never the corpus. */
function tagOverlapOrder(pool: IndexedDocumentMeta[], tokenSet: Set<string>): string[] {
  return pool
    .map((doc) => ({ id: doc.nodeId, overlap: doc.tags.filter((tag) => tokenSet.has(tag.toLowerCase())).length }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

/**
 * Fuse the lexical order (already computed by the SQL candidate query — see
 * {@link rankCandidates}) with the adapter's tag/neighbor signal lists via
 * Reciprocal Rank Fusion (k=60). `pool` is metadata-only — this never reads
 * or ranks a record's body text.
 */
function fusePool(
  store: JournalIndexStore,
  pool: IndexedDocumentMeta[],
  tokens: string[],
  lexicalOrder: string[],
): Map<string, { score: number; via: Set<string> }> {
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
 * Rank a SQL-bounded candidate pool (see {@link
 * JournalIndexStore.candidateDocumentsMeta}) against the prompt, fusing three
 * ranked signals:
 *   1. lexical  — FTS5/BM25 order (best-first); the SQL candidate query
 *                 already returns rows in this order, so this is read off
 *                 `candidates` directly rather than queried a second time.
 *   2. tag      — prompt-token / tag overlap count, descending, computed
 *                 over `candidates` only (never the corpus).
 *   3. neighbor — graph neighbours of the top lexical+tag seeds, over
 *                 refines / depends-on / parent / supersession edges.
 *
 * Graph-neighbor expansion may legitimately reach documents OUTSIDE
 * `candidates` (a seed's linked neighbor need not itself be a lexical/tag
 * match) — but that reach is bounded by (seed count x edges per seed), via a
 * single targeted `id IN (...)` lookup, never by a corpus- or topic-wide
 * read. Expansion targets are filtered to the same visibility `scope`
 * (topic equality when scoped, status per `includeHistory`) the candidate
 * query itself applied.
 */
function rankCandidates(
  store: JournalIndexStore,
  candidates: IndexedDocumentMeta[],
  tokens: string[],
  scope: { topic?: string; includeHistory: boolean },
): { fused: Map<string, { score: number; via: Set<string> }>; pool: IndexedDocumentMeta[] } {
  const poolIds = new Set(candidates.map((doc) => doc.nodeId));
  const byId = new Map(candidates.map((doc) => [doc.nodeId, doc]));
  const lexicalOrder = candidates.map((doc) => doc.nodeId); // SQL already returned bm25 order.
  const tokenSet = new Set(tokens);

  const tagSeedOrder = tagOverlapOrder(candidates, tokenSet);
  const seeds = [...new Set([...lexicalOrder, ...tagSeedOrder])].slice(0, NEIGHBOR_SEED_LIMIT);

  const missingTargets = new Set<string>();
  for (const id of seeds) {
    for (const link of byId.get(id)?.links ?? []) {
      if (!NEIGHBOR_EDGE_TYPES.has(link.type) || poolIds.has(link.target)) continue;
      missingTargets.add(link.target);
    }
  }

  let pool = candidates;
  if (missingTargets.size > 0) {
    const fetched = store.documentsMetaByIds([...missingTargets]);
    const inScope = fetched.filter(
      (doc) =>
        (scope.includeHistory || doc.status !== 'superseded') && (scope.topic === undefined || doc.topic === scope.topic),
    );
    if (inScope.length > 0) {
      pool = [...candidates, ...inScope];
      for (const doc of inScope) {
        poolIds.add(doc.nodeId);
        byId.set(doc.nodeId, doc);
      }
    }
  }

  return { fused: fusePool(store, pool, tokens, lexicalOrder), pool };
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

/** Run one candidate-bounded ranking pass and resolve it to candidate metas. */
function rankPass(
  store: JournalIndexStore,
  candidates: IndexedDocumentMeta[],
  tokens: string[],
  scope: { topic?: string; includeHistory: boolean },
  fallback: boolean,
): JournalCandidateMeta[] {
  const { fused, pool } = rankCandidates(store, candidates, tokens, scope);
  const byId = new Map(pool.map((doc) => [doc.nodeId, doc]));
  return toCandidateMetas(fused, byId, fallback);
}

async function search(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string; includeHistory: boolean },
): Promise<JournalCandidate[]> {
  const tokens = tokenize(input.prompt);
  // No tokens can never win any fused signal (lexical/tag/neighbor-seeded-
  // from-lexical-or-tag are all driven off tokens) regardless of what a query
  // against the database would return, so skip the query entirely.
  if (tokens.length === 0) return [];

  const candidateOpts = (topic: string | undefined) => ({
    tokens,
    topic,
    includeHistory: input.includeHistory,
    limit: CANDIDATE_CAP,
  });

  let metas: JournalCandidateMeta[];
  if (!input.topic) {
    const candidates = store.candidateDocumentsMeta(candidateOpts(undefined));
    metas = rankPass(store, candidates, tokens, { topic: undefined, includeHistory: input.includeHistory }, false);
  } else {
    const inTopicScope = { topic: input.topic, includeHistory: input.includeHistory };
    const inTopicCandidates = store.candidateDocumentsMeta(candidateOpts(input.topic));
    const results = rankPass(store, inTopicCandidates, tokens, inTopicScope, false);

    // Cross-topic fallback ONLY when the in-topic pass is thin (< MIN_IN_TOPIC).
    if (results.length >= MIN_IN_TOPIC) {
      metas = results;
    } else {
      const present = new Set(results.map((candidate) => candidate.nodeId));
      const crossCandidates = store.candidateDocumentsMeta(candidateOpts(undefined));
      const crossResults = rankPass(
        store,
        crossCandidates,
        tokens,
        { topic: undefined, includeHistory: input.includeHistory },
        true,
      ).filter((candidate) => !present.has(candidate.nodeId));
      metas = [...results, ...crossResults];
    }
  }

  // Body is fetched ONCE, only for the ids that survived ranking — never for
  // the whole candidate pool.
  const bodyById = store.documentsBodyByIds(metas.map((meta) => meta.nodeId));
  return metas.map((meta) => ({
    ...meta,
    description: clip(meta.description, DESCRIPTION_MAX),
    snippet: makeSnippet(meta.title, meta.description, bodyById.get(meta.nodeId) ?? ''),
  }));
}

/**
 * Recall retrieval. Returns previews bounded by
 * {@link RECALL_PREVIEW_BUDGET_BYTES} plus the count of ranked candidates the
 * budget dropped, so a caller can never mistake a trimmed set for a complete
 * one. Ranking is unchanged; only the assembled payload is bounded.
 */
export async function searchCandidatesForRecall(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string; includeHistory: boolean },
): Promise<RecallCandidateSet> {
  await store.ensureHealthy();
  // Cheap count-based freshness gate — skips the O(N) stat sweep in steady state.
  await store.ensureFresh();
  return applyPreviewBudget(await search(store, input), RECALL_PREVIEW_BUDGET_BYTES);
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

/**
 * Batch counterpart of {@link searchCandidatesForRecord}: health + freshness
 * run ONCE for the whole batch, not once per submitted record. A
 * `journal_record` request with N records previously paid health/freshness
 * work N times (once per {@link searchCandidatesForRecord} call) even though
 * nothing in the store changes between records within one request — searching
 * record 2 can never observe a staleness that record 1's check didn't already
 * resolve, so the repeat work was pure waste. Same per-search semantics as
 * {@link searchCandidatesForRecord} (record retrieval never surfaces
 * superseded history) for every record in the batch.
 */
export async function searchCandidatesForRecordBatch(
  store: JournalIndexStore,
  records: Array<{ prompt: string; topic?: string }>,
): Promise<JournalCandidate[][]> {
  await store.ensureHealthy();
  // Cheap count-based freshness gate — skips the O(N) stat sweep in steady state.
  await store.ensureFresh();
  const results: JournalCandidate[][] = [];
  for (const record of records) {
    results.push(await search(store, { prompt: record.prompt, topic: record.topic, includeHistory: false }));
  }
  return results;
}
