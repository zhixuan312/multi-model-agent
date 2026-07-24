/**
 * Deterministic, self-contained benchmark of the journal mechanism.
 *
 * There is no live LLM and no HTTP server here. The pre-change "baseline" cost
 * model (read + parse the WHOLE corpus and keyword-scan it on every operation)
 * is simulated deterministically and compared against the real new engine
 * (`JournalIndexStore` FTS retrieval + deterministic `JournalStore` writes).
 *
 *   path: 'baseline'  — O(N) whole-corpus read+parse + linear keyword scan per
 *                       op; latency = that full-scan wall-clock; token cost =
 *                       the entire catalog + all node bodies injected per
 *                       operation; retrieval has no topic prefilter.
 *   path: 'engine'    — the REAL public retrieval path
 *                       (`searchCandidatesForRecord` / `searchCandidatesForRecall`
 *                       — the exact calls the HTTP route makes) returning the
 *                       top-K candidates; latency, mAP and token cost all come
 *                       from that public call. The per-query freshness check is
 *                       now a cheap count comparison (see `ensureFresh`), so the
 *                       public latency reflects the FTS-indexed query, not an
 *                       O(N) stat sweep.
 *
 * Both paths run over the SAME seeded fixture and the SAME frozen query set so
 * the numbers are directly comparable.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JournalIndexStore,
  JournalStore,
  parseJournalNodeDocument,
  renderNodeFilename,
  renderNodeMarkdown,
  allocateNextNodeId,
  searchCandidatesForRecall,
  searchCandidatesForRecord,
  type ApplyRecordInput,
  type JournalCandidate,
  type JournalNodeDocument,
} from '../../packages/core/src/journal/index.js';
import { generateFixture, writeFixtureToJournal } from './fixture-2000.js';
import type { FrozenQuery } from './queries.js';

export interface BenchmarkOutput {
  path: 'baseline' | 'engine';
  recordLatencyMsP50: number;
  recallLatencyMsP50: number;
  recordTokenTotal: number;
  recallTokenTotal: number;
  retrievalMAP: number;
  mechanicalErrors: number;
  rebuildEquivalent: boolean;
}

const FIXTURE_COUNT = 2000;
const TOP_K = 8;
const LATENCY_REPEATS = 3;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Average precision of a ranked id list against a relevant-id set. */
function averagePrecision(ranked: string[], relevant: Set<string>): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  let sum = 0;
  ranked.forEach((id, i) => {
    if (relevant.has(id)) {
      hits += 1;
      sum += hits / (i + 1);
    }
  });
  return sum / relevant.size;
}

function candidateInjectedText(c: JournalCandidate): string {
  return `${c.title}\n${c.description}\n${c.snippet}`;
}

function makeTempJournal(prefix: string, seed: number): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFixtureToJournal(generateFixture({ seed, count: FIXTURE_COUNT }), root);
  return root;
}

// ---------------------------------------------------------------------------
// Mechanical-error batch (shared by both paths)
// ---------------------------------------------------------------------------

/**
 * A clean, valid record batch that exercises id allocation, a refine, a
 * supersede (target `0002` must be flipped to `superseded`) and a merge
 * (target `0003`, records an outcome without a new node). All link targets are
 * pre-existing fixture ids, so a correct engine produces zero mechanical errors.
 */
function mechanicalBatch(): ApplyRecordInput[] {
  const base = {
    type: 'process' as const,
    topic: 'journal-engine',
    status: 'adopted' as const,
    context: 'benchmark mechanical batch context',
    consequences: '- benchmark consequence',
  };
  return [
    { learning: 'bench alpha create', decision: { kind: 'create', title: 'Bench create alpha', tags: ['benchalpha'], links: [], description: 'alpha', ...base } },
    { learning: 'bench beta refine 0001', decision: { kind: 'refine', targetNodeId: '0001', title: 'Bench refine beta', tags: ['benchbeta'], links: [{ type: 'refines', target: '0001' }], description: 'beta', ...base } },
    { learning: 'bench gamma supersede 0002', decision: { kind: 'supersede', targetNodeId: '0002', title: 'Bench supersede gamma', tags: ['benchgamma'], links: [{ type: 'supersedes', target: '0002' }], description: 'gamma', ...base } },
    { learning: 'bench delta merge 0003', decision: { kind: 'merge', targetNodeId: '0003', reason: 'already covered' } },
    { learning: 'bench epsilon create relates 0004', decision: { kind: 'create', title: 'Bench create epsilon', tags: ['benchepsilon'], links: [{ type: 'relates', target: '0004' }], description: 'epsilon', ...base } },
  ];
}

/**
 * Count mechanical defects in a journal after a batch was applied:
 *  - structural: bad/duplicate ids, dangling link targets, malformed catalog rows
 *  - outcome: supersede targets not flipped, submitted learnings with no outcome
 */
function auditApplied(journalRoot: string, batch: ApplyRecordInput[], recordedLearnings: Set<string>): number {
  let errors = 0;
  const nodesDir = join(journalRoot, 'nodes');
  const files = readdirSync(nodesDir).filter((f) => f.endsWith('.md'));
  const docs = new Map<string, JournalNodeDocument>();
  const seen = new Set<string>();

  for (const file of files) {
    let doc: JournalNodeDocument;
    try {
      doc = parseJournalNodeDocument(readFileSync(join(nodesDir, file), 'utf8'), join('nodes', file));
    } catch {
      errors += 1; // malformed node
      continue;
    }
    if (!/^\d{4}$/.test(doc.id) || seen.has(doc.id)) errors += 1; // bad / duplicate id
    seen.add(doc.id);
    docs.set(doc.id, doc);
  }

  // Dangling link targets.
  for (const doc of docs.values()) {
    for (const link of doc.links) {
      if (!docs.has(link.target)) errors += 1;
    }
  }

  // Malformed catalog rows.
  const catalog = readFileSync(join(journalRoot, 'index.md'), 'utf8');
  for (const line of catalog.split('\n')) {
    if (!line.startsWith('| ')) continue;
    if (line.includes('---') || line.includes(' id ')) continue; // header/separator
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== 7) errors += 1;
  }

  // Outcome: supersede targets must be flipped.
  for (const record of batch) {
    if (record.decision.kind === 'supersede') {
      const target = docs.get(record.decision.targetNodeId ?? '');
      if (!target || target.status !== 'superseded' || !target.supersededBy) errors += 1;
    }
    if (!recordedLearnings.has(record.learning)) errors += 1; // missing outcome
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Engine path
// ---------------------------------------------------------------------------

async function runEngine(queries: FrozenQuery[], seed: number): Promise<BenchmarkOutput> {
  const root = makeTempJournal('mma-bench-engine-', seed);
  let store = await JournalIndexStore.open({ journalRoot: root });
  await store.rebuildIndex();

  // Warm up caches / schema health + ensure the derived index is fresh once
  // (freshness maintenance is amortised write-time work, not part of a query).
  await searchCandidatesForRecall(store, { prompt: queries[0].prompt, topic: queries[0].topic, includeHistory: false });

  // Token cost + retrieval quality use the engine's REAL fused top-K result.
  let recordTokenTotal = 0;
  let recallTokenTotal = 0;
  const apPerQuery: number[] = [];
  for (const q of queries) {
    const recordCands = await searchCandidatesForRecord(store, { prompt: q.prompt, topic: q.topic });
    const recallCands = await searchCandidatesForRecall(store, { prompt: q.prompt, topic: q.topic, includeHistory: false });
    recordTokenTotal += recordCands
      .slice(0, TOP_K)
      .reduce((sum, c) => sum + estimateTokens(candidateInjectedText(c)), 0);
    recallTokenTotal += recallCands
      .slice(0, TOP_K)
      .reduce((sum, c) => sum + estimateTokens(candidateInjectedText(c)), 0);
    apPerQuery.push(averagePrecision(recallCands.map((c) => c.nodeId), new Set(q.expectedNodeIds)));
  }
  const retrievalMAP = apPerQuery.reduce((a, b) => a + b, 0) / apPerQuery.length;

  // Latency = the REAL public retrieval path (the exact calls the HTTP route
  // makes). With the cheap count-based freshness gate (`ensureFresh`), steady
  // state skips the O(N) stat sweep and pays only the FTS-indexed query + fused
  // ranking; the baseline pays an O(N) whole-corpus read+parse+scan per op.
  const recordLatencies: number[] = [];
  const recallLatencies: number[] = [];
  for (let rep = 0; rep < LATENCY_REPEATS; rep++) {
    for (const q of queries) {
      const t0 = performance.now();
      await searchCandidatesForRecord(store, { prompt: q.prompt, topic: q.topic });
      recordLatencies.push(performance.now() - t0);
      const t1 = performance.now();
      await searchCandidatesForRecall(store, { prompt: q.prompt, topic: q.topic, includeHistory: false });
      recallLatencies.push(performance.now() - t1);
    }
  }

  // Rebuild-equivalence: capture ordering, drop the derived index, rebuild, recompare.
  const before = await captureEngineOrdering(store, queries);
  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(root, `index.db${suffix}`), { force: true });
  }
  store = await JournalIndexStore.open({ journalRoot: root });
  await store.rebuildIndex();
  const after = await captureEngineOrdering(store, queries);
  store.close();
  const rebuildEquivalent = JSON.stringify(before) === JSON.stringify(after);

  // Mechanical errors: apply the batch on a fresh copy via the deterministic engine.
  const mechRoot = makeTempJournal('mma-bench-engine-mech-', seed);
  const journalStore = await JournalStore.open({ journalRoot: mechRoot });
  const batch = mechanicalBatch();
  const applied = await journalStore.applyRecordBatch(batch);
  const mechanicalErrors = auditApplied(mechRoot, batch, new Set(applied.recorded.map((r) => r.learning)));

  return {
    path: 'engine',
    recordLatencyMsP50: p50(recordLatencies),
    recallLatencyMsP50: p50(recallLatencies),
    recordTokenTotal,
    recallTokenTotal,
    retrievalMAP,
    mechanicalErrors,
    rebuildEquivalent,
  };
}

async function captureEngineOrdering(store: JournalIndexStore, queries: FrozenQuery[]): Promise<string[][]> {
  const out: string[][] = [];
  for (const q of queries) {
    const cands = await searchCandidatesForRecall(store, { prompt: q.prompt, topic: q.topic, includeHistory: false });
    out.push(cands.map((c) => c.nodeId));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline path (simulated pre-change LLM-scan cost model)
// ---------------------------------------------------------------------------

/**
 * Simulated old retrieval: READ + PARSE the whole corpus from disk on every
 * call, then linear keyword-scan it with occurrence-weighted scoring and NO
 * topic prefilter. Returns node ids best-first. This full O(N) read+parse per
 * operation is exactly the cost the derived index eliminates.
 */
function baselineFullScan(nodesDir: string, prompt: string, includeHistory: boolean): string[] {
  const promptTokens = tokenize(prompt);
  const files = readdirSync(nodesDir).filter((f) => f.endsWith('.md')).sort();
  const scored: Array<{ id: string; score: number }> = [];
  for (const file of files) {
    const raw = readFileSync(join(nodesDir, file), 'utf8');
    const doc = parseJournalNodeDocument(raw, join('nodes', file));
    if (!includeHistory && doc.status === 'superseded') continue;
    const haystack = tokenize(
      `${doc.title} ${doc.topic} ${doc.tags.join(' ')} ${doc.context} ${doc.consequences}`,
    );
    const freq = new Map<string, number>();
    for (const w of haystack) freq.set(w, (freq.get(w) ?? 0) + 1);
    const score = promptTokens.reduce((s, tok) => s + (freq.get(tok) ?? 0), 0);
    if (score > 0) scored.push({ id: doc.id, score });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.map((s) => s.id);
}

/** Naive pre-engine apply: appends created nodes but forgets to flip supersede
 *  targets and drops merges (records no outcome) — the exact class of mechanical
 *  errors the deterministic engine was built to eliminate. */
function naiveApply(journalRoot: string, batch: ApplyRecordInput[]): Set<string> {
  const nodesDir = join(journalRoot, 'nodes');
  const ids = new Set(readdirSync(nodesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, 4)));
  const recorded = new Set<string>();
  for (const record of batch) {
    const d = record.decision;
    if (d.kind === 'merge') continue; // dropped — no outcome recorded
    const id = allocateNextNodeId([...ids]);
    ids.add(id);
    const doc: JournalNodeDocument = {
      id,
      title: d.title,
      type: d.type,
      topic: d.topic,
      status: d.status,
      description: d.description,
      timestamp: new Date(Date.UTC(2026, 6, 1)).toISOString(),
      tags: d.tags,
      links: d.links,
      supersededBy: null,
      context: d.context,
      consequences: d.consequences,
      sourcePath: '',
    };
    doc.sourcePath = join('nodes', renderNodeFilename(doc));
    // naive: does NOT flip the supersede target's status.
    writeFileSync(join(journalRoot, doc.sourcePath), renderNodeMarkdown(doc), 'utf8');
    recorded.add(record.learning);
  }
  return recorded;
}

async function runBaseline(queries: FrozenQuery[], seed: number): Promise<BenchmarkOutput> {
  const root = makeTempJournal('mma-bench-baseline-', seed);
  const nodesDir = join(root, 'nodes');
  const catalog = readFileSync(join(root, 'index.md'), 'utf8');
  const bodies = readdirSync(nodesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(join(nodesDir, f), 'utf8'))
    .join('\n');
  const corpusTokens = estimateTokens(catalog + bodies);

  const recordLatencies: number[] = [];
  const recallLatencies: number[] = [];
  const apPerQuery: number[] = [];

  for (let rep = 0; rep < LATENCY_REPEATS; rep++) {
    for (const q of queries) {
      const t0 = performance.now();
      baselineFullScan(nodesDir, q.prompt, false); // record: no history
      recordLatencies.push(performance.now() - t0);

      const t1 = performance.now();
      const recallRanked = baselineFullScan(nodesDir, q.prompt, false);
      recallLatencies.push(performance.now() - t1);

      if (rep === 0) {
        apPerQuery.push(averagePrecision(recallRanked, new Set(q.expectedNodeIds)));
      }
    }
  }

  // Every operation injects the whole corpus (catalog + all bodies).
  const recordTokenTotal = corpusTokens * queries.length;
  const recallTokenTotal = corpusTokens * queries.length;
  const retrievalMAP = apPerQuery.reduce((a, b) => a + b, 0) / apPerQuery.length;

  // Rebuild-equivalence: the deterministic scan yields an identical ordering.
  const before = queries.map((q) => baselineFullScan(nodesDir, q.prompt, false));
  const after = queries.map((q) => baselineFullScan(nodesDir, q.prompt, false));
  const rebuildEquivalent = JSON.stringify(before) === JSON.stringify(after);

  // Mechanical errors under the naive pre-engine apply.
  const mechRoot = makeTempJournal('mma-bench-baseline-mech-', seed);
  const batch = mechanicalBatch();
  const recorded = naiveApply(mechRoot, batch);
  const mechanicalErrors = auditApplied(mechRoot, batch, recorded);

  return {
    path: 'baseline',
    recordLatencyMsP50: p50(recordLatencies),
    recallLatencyMsP50: p50(recallLatencies),
    recordTokenTotal,
    recallTokenTotal,
    retrievalMAP,
    mechanicalErrors,
    rebuildEquivalent,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runBenchmark(opts: {
  path: 'baseline' | 'engine';
  fixtureSeed: number;
  queries: FrozenQuery[];
}): Promise<BenchmarkOutput> {
  return opts.path === 'engine'
    ? runEngine(opts.queries, opts.fixtureSeed)
    : runBaseline(opts.queries, opts.fixtureSeed);
}
