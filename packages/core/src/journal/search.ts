import type { IndexedDocument, JournalIndexStore } from './index-store.js';

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

interface RankedList {
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
function rankPool(
  store: JournalIndexStore,
  pool: IndexedDocument[],
  tokens: string[],
): Map<string, { score: number; via: Set<string> }> {
  const poolIds = new Set(pool.map((doc) => doc.nodeId));
  const byId = new Map(pool.map((doc) => [doc.nodeId, doc]));

  // Signal 1: lexical (FTS5/BM25). Filter global hits down to the pool.
  const lexicalOrder = store
    .lexicalSearch(tokens)
    .map((hit) => hit.nodeId)
    .filter((id) => poolIds.has(id));

  // Signal 2: tag overlap.
  const tokenSet = new Set(tokens);
  const tagScored = pool
    .map((doc) => ({
      id: doc.nodeId,
      overlap: doc.tags.filter((tag) => tokenSet.has(tag.toLowerCase())).length,
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id))
    .map((entry) => entry.id);

  // Signal 3: graph-neighbor expansion over allowed edge types.
  const seeds = [...new Set([...lexicalOrder, ...tagScored])].slice(0, NEIGHBOR_SEED_LIMIT);
  const neighborOrder: string[] = [];
  const neighborSeen = new Set<string>();
  for (const seedId of seeds) {
    const seed = byId.get(seedId);
    if (!seed) continue;
    for (const link of seed.links) {
      if (!NEIGHBOR_EDGE_TYPES.has(link.type)) continue;
      if (!poolIds.has(link.target)) continue;
      if (neighborSeen.has(link.target)) continue;
      neighborSeen.add(link.target);
      neighborOrder.push(link.target);
    }
  }

  const lists: RankedList[] = [
    { via: 'lexical', order: lexicalOrder },
    { via: 'tag', order: tagScored },
    { via: 'neighbor', order: neighborOrder },
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

function toCandidates(
  fused: Map<string, { score: number; via: Set<string> }>,
  byId: Map<string, IndexedDocument>,
  fallback: boolean,
): JournalCandidate[] {
  const out: JournalCandidate[] = [];
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
      snippet: makeSnippet(doc),
      score: entry.score,
      fallback,
      matchedVia: [...entry.via],
    });
  }
  return out.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
}

function search(
  store: JournalIndexStore,
  input: { prompt: string; topic?: string; includeHistory: boolean },
): JournalCandidate[] {
  const tokens = tokenize(input.prompt);
  const visible = store
    .allDocuments()
    .filter((doc) => input.includeHistory || doc.status !== 'superseded');
  const byId = new Map(visible.map((doc) => [doc.nodeId, doc]));

  if (!input.topic) {
    const fused = rankPool(store, visible, tokens);
    return toCandidates(fused, byId, false);
  }

  const inTopic = visible.filter((doc) => doc.topic === input.topic);
  const inTopicFused = rankPool(store, inTopic, tokens);
  const results = toCandidates(inTopicFused, byId, false);

  // Cross-topic fallback ONLY when the in-topic pass is thin (< MIN_IN_TOPIC).
  if (results.length >= MIN_IN_TOPIC) return results;

  const present = new Set(results.map((candidate) => candidate.nodeId));
  const crossFused = rankPool(store, visible, tokens);
  const crossResults = toCandidates(crossFused, byId, true).filter(
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
