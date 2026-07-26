/**
 * Synthetic journal corpus generator for the deterministic-engine benchmark.
 *
 * The fixture is fully deterministic: the same `{ seed, count }` always yields
 * a byte-identical node list (seeded mulberry32 RNG, no clock, no Math.random).
 * A block of hand-placed "landmark" nodes at low, stable ids realises every
 * retrieval/record scenario and backs the frozen query set in `queries.ts`;
 * the remainder is deterministic filler acting as retrieval noise/distractors.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderNodeFilename,
  renderNodeMarkdown,
  validateJournalLinkSet,
  type JournalLink,
  type JournalLinkType,
  type JournalNodeDocument,
  type JournalNodeStatus,
  type JournalNodeType,
} from '../../packages/core/src/journal/index.js';

export type Scenario =
  | 'create'
  | 'refine'
  | 'merge'
  | 'supersede'
  | 'contradiction'
  | 'graph-neighbor'
  | 'cross-topic';

export interface FixtureNode {
  id: string;
  title: string;
  type: string;
  topic: string;
  status: string;
  tags: string[];
  links: { type: string; target: string }[];
  scenario: Scenario;
  body: string;
}

/** Deterministic RNG — same seed → identical stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  'journal-engine',
  'retrieval-ranking',
  'sqlite-index',
  'skill-contracts',
  'cli-tooling',
];

const NODE_TYPES: JournalNodeType[] = [
  'decision',
  'design',
  'behavior',
  'process',
  'knowledge',
  'style',
];

/** Common tokens shared broadly across the corpus (retrieval noise). */
const COMMON_POOL = [
  'deterministic',
  'index',
  'ranking',
  'retrieval',
  'writes',
  'schema',
  'candidate',
  'sync',
  'catalog',
  'engine',
  'node',
  'lexical',
];

/**
 * Frozen landmark query specification. Each spec seeds two adopted "expected"
 * nodes in `topic` carrying the rare single-token `keyword` (both as a tag and
 * in the body), plus cross-topic distractor nodes that reuse the keyword in a
 * DIFFERENT topic. The engine's topic prefilter + IDF-weighted lexical scoring
 * ranks the in-topic expected nodes first; a whole-corpus keyword scan surfaces
 * the cross-topic distractors and loses precision.
 */
export interface LandmarkSpec {
  keyword: string;
  topic: string;
  common: [string, string];
  prompt: string;
}

export const LANDMARK_SPECS: LandmarkSpec[] = [
  { keyword: 'zephyr', topic: 'journal-engine', common: ['deterministic', 'writes'], prompt: 'how the zephyr deterministic engine keeps writes small' },
  { keyword: 'quorum', topic: 'retrieval-ranking', common: ['ranking', 'fusion'], prompt: 'quorum ranking fusion for retrieval candidates' },
  { keyword: 'basilisk', topic: 'sqlite-index', common: ['index', 'health'], prompt: 'basilisk index health rebuild before serving recall' },
  { keyword: 'tessellate', topic: 'skill-contracts', common: ['decision', 'schema'], prompt: 'tessellate decision schema contract for records' },
  { keyword: 'obsidian', topic: 'cli-tooling', common: ['reindex', 'command'], prompt: 'obsidian reindex command rebuilds derived index' },
  { keyword: 'nimbus', topic: 'journal-engine', common: ['merge', 'duplicate'], prompt: 'nimbus merge decision avoids duplicate nodes' },
  { keyword: 'cascade', topic: 'retrieval-ranking', common: ['graph', 'neighbor'], prompt: 'cascade graph neighbor expansion over edges' },
  { keyword: 'lattice', topic: 'sqlite-index', common: ['incremental', 'sync'], prompt: 'lattice incremental sync keyed by mtime hash' },
  { keyword: 'meridian', topic: 'skill-contracts', common: ['recall', 'history'], prompt: 'meridian recall includes history when asked' },
  { keyword: 'pyroxene', topic: 'cli-tooling', common: ['catalog', 'regeneration'], prompt: 'pyroxene catalog regeneration stays deterministic' },
  { keyword: 'halcyon', topic: 'journal-engine', common: ['supersede', 'status'], prompt: 'halcyon supersede marks the old node superseded' },
  { keyword: 'zenith', topic: 'retrieval-ranking', common: ['fallback', 'topic'], prompt: 'zenith fallback ranking across topics' },
];

/** All rare keywords — filler must never reuse these. */
const KEYWORDS = new Set(LANDMARK_SPECS.map((s) => s.keyword));

function padId(n: number): string {
  return String(n).padStart(4, '0');
}

function differentTopic(topic: string, rand: () => number): string {
  const others = TOPICS.filter((t) => t !== topic);
  return others[Math.floor(rand() * others.length)];
}

/**
 * Deterministically generate the corpus.
 *
 * Layout (stable, seed-independent ids):
 *   0001..0024  expected landmark pairs (2 per query spec)
 *   0025..0029  scenario landmarks (supersede / contradiction / merge / cross-topic)
 *   0030..0053  cross-topic keyword distractors (2 per query spec)
 *   0054..count deterministic filler (retrieval noise)
 */
export function generateFixture(opts: { seed: number; count: number }): FixtureNode[] {
  const { seed, count } = opts;
  const rand = mulberry32(seed);
  const nodes: FixtureNode[] = [];

  // --- 1. Expected landmark pairs (ids 0001..0024) -------------------------
  LANDMARK_SPECS.forEach((spec, i) => {
    const aId = padId(nodes.length + 1);
    const bId = padId(nodes.length + 2);
    const [c0, c1] = spec.common;
    nodes.push({
      id: aId,
      title: `${spec.keyword} ${c0} ${c1} primary`,
      type: NODE_TYPES[i % NODE_TYPES.length],
      topic: spec.topic,
      status: 'adopted',
      tags: [spec.keyword, c0, c1],
      links: [],
      scenario: 'create',
      body: `The ${spec.keyword} approach governs ${c0} and ${c1} in the ${spec.topic} area. ${spec.keyword} keeps ${c0} correct.`,
    });
    nodes.push({
      id: bId,
      title: `${spec.keyword} ${c0} refinement`,
      type: NODE_TYPES[(i + 3) % NODE_TYPES.length],
      topic: spec.topic,
      status: 'adopted',
      tags: [spec.keyword, c0],
      links: [{ type: 'refines', target: aId }],
      scenario: i % 2 === 0 ? 'refine' : 'graph-neighbor',
      body: `A refinement of ${spec.keyword} adds a new ${c0} failure mode. ${spec.keyword} still drives ${c1}.`,
    });
  });

  // --- 2. Scenario landmarks (ids 0025..0029) ------------------------------
  const oldId = padId(nodes.length + 1); // 0025 — superseded
  const newId = padId(nodes.length + 2); // 0026 — supersedes 0025
  nodes.push({
    id: oldId,
    title: 'legacy manual writer note',
    type: 'process',
    topic: 'journal-engine',
    status: 'superseded',
    tags: ['legacy', 'writes'],
    links: [],
    scenario: 'create',
    body: 'The legacy manual writer edited node files by hand and drifted from the catalog.',
  });
  nodes.push({
    id: newId,
    title: 'deterministic writer supersedes manual edits',
    type: 'process',
    topic: 'journal-engine',
    status: 'adopted',
    tags: ['deterministic', 'writes'],
    links: [{ type: 'supersedes', target: oldId }],
    scenario: 'supersede',
    body: 'The deterministic writer supersedes the manual writer and keeps writes atomic.',
  });
  nodes.push({
    id: padId(nodes.length + 1), // 0027
    title: 'contradiction over ranking weights',
    type: 'decision',
    topic: 'retrieval-ranking',
    status: 'adopted',
    tags: ['ranking', 'conflict'],
    links: [{ type: 'contradicts', target: '0003' }],
    scenario: 'contradiction',
    body: 'This note contradicts an earlier ranking weight decision about retrieval.',
  });
  nodes.push({
    id: padId(nodes.length + 1), // 0028
    title: 'duplicate merge candidate about catalog sync',
    type: 'knowledge',
    topic: 'sqlite-index',
    status: 'adopted',
    tags: ['catalog', 'sync'],
    links: [],
    scenario: 'merge',
    body: 'A duplicate learning about catalog sync that a record pass should merge into an existing node.',
  });
  nodes.push({
    id: padId(nodes.length + 1), // 0029
    title: 'cross-topic aside about tooling',
    type: 'style',
    topic: 'cli-tooling',
    status: 'adopted',
    tags: ['tooling', 'aside'],
    links: [],
    scenario: 'cross-topic',
    body: 'A cross-topic aside that shares generic tooling vocabulary but no rare keyword.',
  });

  // --- 3. Cross-topic keyword distractors (ids 0030..0053) -----------------
  // Each carries a query keyword but in the WRONG topic, with the query's
  // common words repeated so a whole-corpus scan ranks it high; the engine's
  // topic prefilter drops it.
  LANDMARK_SPECS.forEach((spec) => {
    const [c0, c1] = spec.common;
    const repeated = `${c0} ${c1} ${c0} ${c1} ${c0} ${c1}`;
    for (let k = 0; k < 2; k++) {
      nodes.push({
        id: padId(nodes.length + 1),
        title: `${spec.keyword} off-topic distractor ${k}`,
        type: NODE_TYPES[Math.floor(rand() * NODE_TYPES.length)],
        topic: differentTopic(spec.topic, rand),
        status: 'adopted',
        tags: [spec.keyword, c0],
        links: [],
        scenario: 'cross-topic',
        body: `Off-topic mention of ${spec.keyword}. ${repeated}. ${repeated}.`,
      });
    }
  });

  // --- 4. Deterministic filler (ids 0054..count) ---------------------------
  const fillerScenarios: Scenario[] = ['create', 'refine', 'graph-neighbor', 'cross-topic', 'merge', 'contradiction'];
  while (nodes.length < count) {
    const idNum = nodes.length + 1;
    const id = padId(idNum);
    const topic = TOPICS[Math.floor(rand() * TOPICS.length)];
    const w0 = COMMON_POOL[Math.floor(rand() * COMMON_POOL.length)];
    const w1 = COMMON_POOL[Math.floor(rand() * COMMON_POOL.length)];
    const w2 = COMMON_POOL[Math.floor(rand() * COMMON_POOL.length)];
    const scenario = fillerScenarios[idNum % fillerScenarios.length];
    const links: { type: string; target: string }[] = [];
    // Add a valid edge to an earlier node for graph density (~40% of filler).
    if (idNum > 60 && rand() < 0.4) {
      const targetNum = 1 + Math.floor(rand() * (idNum - 1));
      const linkType: JournalLinkType =
        scenario === 'contradiction' ? 'contradicts' : scenario === 'graph-neighbor' ? 'refines' : 'relates';
      links.push({ type: linkType, target: padId(targetNum) });
    }
    nodes.push({
      id,
      title: `${w0} ${w1} note ${idNum}`,
      type: NODE_TYPES[Math.floor(rand() * NODE_TYPES.length)],
      topic,
      status: 'adopted',
      tags: [w0, w1],
      links,
      scenario,
      body: `Filler note ${idNum} about ${w0} and ${w1} and ${w2} in the ${topic} area.`,
    });
  }

  return nodes.slice(0, count);
}

// ---------------------------------------------------------------------------
// Materialisation to a real journal tree
// ---------------------------------------------------------------------------

const CATALOG_HEADER =
  '| id | timestamp | type | status | title | topic | tags |\n| --- | --- | --- | --- | --- | --- | --- |\n';

/** Deterministic per-node timestamp (index-derived, no clock). */
function nodeTimestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 60_000).toISOString();
}

function toDocument(node: FixtureNode, index: number, supersededBy: string | null): JournalNodeDocument {
  return {
    id: node.id,
    title: node.title,
    type: node.type as JournalNodeType,
    topic: node.topic,
    status: node.status as JournalNodeStatus,
    description: `${node.title} (${node.scenario})`,
    timestamp: nodeTimestamp(index),
    tags: node.tags,
    links: node.links as JournalLink[],
    supersededBy,
    context: node.body,
    consequences: `- Relevant to ${node.topic}; scenario ${node.scenario}.`,
    sourcePath: '',
  };
}

/**
 * Emit `nodes/NNNN-*.md` for every fixture node plus a regenerated `index.md`
 * catalog and an empty `log.md`, using the real node-codec renderer. Throws if
 * the fixture produced an invalid link set or an unbacked superseded node.
 */
export function writeFixtureToJournal(nodes: FixtureNode[], journalRoot: string): void {
  const nodesDir = join(journalRoot, 'nodes');
  mkdirSync(nodesDir, { recursive: true });

  const ids = new Set(nodes.map((n) => n.id));
  // Reverse-map every `supersedes` edge so superseded nodes get a supersededBy.
  const supersededByMap = new Map<string, string>();
  for (const node of nodes) {
    for (const link of node.links) {
      if (link.type === 'supersedes') supersededByMap.set(link.target, node.id);
    }
  }

  const catalogRows: string[] = [];
  nodes.forEach((node, index) => {
    const supersededBy =
      node.status === 'superseded' ? supersededByMap.get(node.id) ?? null : null;
    if (node.status === 'superseded' && !supersededBy) {
      throw new Error(`Superseded fixture node ${node.id} has no superseding node`);
    }
    validateJournalLinkSet(node.id, node.links as JournalLink[], ids);
    const doc = toDocument(node, index, supersededBy);
    const filename = renderNodeFilename(doc);
    doc.sourcePath = join('nodes', filename);
    writeFileSync(join(nodesDir, filename), renderNodeMarkdown(doc), 'utf8');
    catalogRows.push(
      `| ${node.id} | ${doc.timestamp.slice(0, 10)} | ${node.type} | ${node.status} | ${node.title} | ${node.topic} | ${node.tags.join(', ')} |`,
    );
  });

  writeFileSync(join(journalRoot, 'schema.md'), '# schema\n', 'utf8');
  writeFileSync(join(journalRoot, 'index.md'), `${CATALOG_HEADER}${catalogRows.join('\n')}\n`, 'utf8');
  writeFileSync(join(journalRoot, 'log.md'), '', 'utf8');
}
