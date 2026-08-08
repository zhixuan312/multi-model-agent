import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FROZEN_QUERIES } from '../../benchmarks/journal/queries.js';
import { FIXTURE_COUNT, runBenchmark, type BenchmarkOutput } from '../../benchmarks/journal/run.js';

/**
 * G-1 gate: run the deterministic mechanism benchmark for BOTH the simulated
 * pre-change baseline and the new engine, persist the raw results + a
 * human-readable summary under benchmarks/journal/, then assert every numeric
 * gate on the freshly measured numbers. No LLM, no server, no network.
 */

const BENCH_DIR = resolve('benchmarks/journal');
const UTC_DATE = new Date().toISOString().slice(0, 10);

let baseline: BenchmarkOutput;
let engine: BenchmarkOutput;
let engineSmall: BenchmarkOutput;

function newestBenchmarkFile(): string {
  const files = readdirSync(BENCH_DIR)
    .filter((f) => /^benchmark-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return resolve(BENCH_DIR, files[files.length - 1]);
}

function writeSummary(b: BenchmarkOutput, e: BenchmarkOutput): void {
  const recLat = b.recordLatencyMsP50 / e.recordLatencyMsP50;
  const recallLat = b.recallLatencyMsP50 / e.recallLatencyMsP50;
  const recTok = (b.recordTokenTotal - e.recordTokenTotal) / b.recordTokenTotal;
  const recallTok = (b.recallTokenTotal - e.recallTokenTotal) / b.recallTokenTotal;
  const md = `# Journal Deterministic Engine — Benchmark Summary

Generated ${UTC_DATE} by \`tests/perf/journal-engine-benchmark-gates.test.ts\`.
Deterministic mechanism benchmark over a seeded ${FIXTURE_COUNT}-node fixture and a frozen
query set — no LLM, no server, no network.

- **baseline** = simulated pre-change cost model: read + parse the whole corpus
  and linear keyword-scan it on every operation; the entire catalog + all node
  bodies are injected per operation; retrieval has no topic prefilter.
- **engine** = the new path measured through the REAL public retrieval calls
  the HTTP route makes (\`searchCandidatesForRecord\` / \`searchCandidatesForRecall\`):
  \`JournalIndexStore\` FTS/BM25 + tag + graph retrieval returning top-K
  candidates; only the top-K candidate text is injected; the per-query freshness
  check is a cheap node-count comparison (\`ensureFresh\`), so latency reflects
  the FTS-indexed query rather than an O(N) stat sweep; writes are applied by the
  deterministic \`JournalStore\`.

| Metric | baseline | engine | gate | result |
|---|---:|---:|---|---|
| record latency p50 (ms) | ${b.recordLatencyMsP50.toFixed(3)} | ${e.recordLatencyMsP50.toFixed(3)} | informational only (see sublinear-scaling + ceiling gates below) | ${recLat.toFixed(1)}× |
| recall latency p50 (ms) | ${b.recallLatencyMsP50.toFixed(3)} | ${e.recallLatencyMsP50.toFixed(3)} | informational only (see sublinear-scaling + ceiling gates below) | ${recallLat.toFixed(1)}× |
| record tokens (total) | ${b.recordTokenTotal} | ${e.recordTokenTotal} | ≥ 80% reduction | ${(recTok * 100).toFixed(1)}% |
| recall tokens (total) | ${b.recallTokenTotal} | ${e.recallTokenTotal} | ≥ 80% reduction | ${(recallTok * 100).toFixed(1)}% |
| retrieval mAP | ${b.retrievalMAP.toFixed(4)} | ${e.retrievalMAP.toFixed(4)} | engine ≥ baseline | ${e.retrievalMAP >= b.retrievalMAP ? 'pass' : 'FAIL'} |
| mechanical errors | ${b.mechanicalErrors} | ${e.mechanicalErrors} | engine == 0 | ${e.mechanicalErrors === 0 ? 'pass' : 'FAIL'} |
| rebuild equivalent | ${b.rebuildEquivalent} | ${e.rebuildEquivalent} | engine == true | ${e.rebuildEquivalent ? 'pass' : 'FAIL'} |
`;
  writeFileSync(resolve(BENCH_DIR, 'report-summary.md'), md, 'utf8');
}

describe('journal benchmark gates', () => {
  beforeAll(async () => {
    baseline = await runBenchmark({ path: 'baseline', fixtureSeed: 42, queries: FROZEN_QUERIES });
    engine = await runBenchmark({ path: 'engine', fixtureSeed: 42, queries: FROZEN_QUERIES });
    // Second engine-only arm at a quarter of the corpus, for the sublinear-scaling
    // gate below. No baseline counterpart is needed — that gate compares the
    // engine to itself at two corpus sizes, not to the baseline arm.
    engineSmall = await runBenchmark({ path: 'engine', fixtureSeed: 42, queries: FROZEN_QUERIES, count: 750 });
    mkdirSync(BENCH_DIR, { recursive: true });
    writeFileSync(
      resolve(BENCH_DIR, `benchmark-${UTC_DATE}.json`),
      // fixtureCount is persisted so a report stays self-describing: the corpus
      // size has changed once already (2000 -> 3000) and dated files from either
      // size sit side by side in this directory.
      `${JSON.stringify({ generatedAt: new Date().toISOString(), fixtureCount: FIXTURE_COUNT, baseline, engine }, null, 2)}\n`,
      'utf8',
    );
    writeSummary(baseline, engine);
    // 240s covered two arms (baseline + engine at 3000 records); a third,
    // smaller arm (engine at 750 records) is added above, so the budget is
    // raised to 360s to keep headroom.
  }, 360_000);

  it('persisted a raw benchmark-<UTC-date>.json and report-summary.md', () => {
    const raw = JSON.parse(readFileSync(newestBenchmarkFile(), 'utf8')) as {
      baseline: BenchmarkOutput;
      engine: BenchmarkOutput;
    };
    expect(raw.baseline.path).toBe('baseline');
    expect(raw.engine.path).toBe('engine');
    expect(readFileSync(resolve(BENCH_DIR, 'report-summary.md'), 'utf8')).toContain('Benchmark Summary');
  });

  it('engine does not regress retrieval quality (engine mAP >= baseline mAP)', () => {
    expect(engine.retrievalMAP).toBeGreaterThanOrEqual(baseline.retrievalMAP);
  });

  it('engine writes are mechanically clean and the index rebuilds identically', () => {
    expect(engine.mechanicalErrors).toBe(0);
    expect(engine.rebuildEquivalent).toBe(true);
  });

  // LATENCY GATES: sublinear scaling + an absolute catastrophe ceiling.
  //
  // What actually broke in #227, and what these gates check for directly: per-query
  // engine work became proportional to CORPUS SIZE instead of to the CANDIDATE SET a
  // query returns. The adapter read the whole record set on every query rather than
  // only the top-K candidates. That is a property of the algorithm, not of the
  // machine running it, so it can be gated directly and cannot be flaked by CI
  // hardware being slower or faster than a laptop.
  //
  // This file used to gate a RATIO against a simulated baseline arm instead
  // (`baseline.p50 / engine.p50 >= MIN_SPEEDUP`). That combines TWO independently
  // noisy wall-clock measurements into one number: stored history in
  // benchmarks/journal/benchmark-*.json shows the baseline arm alone swinging
  // between 51ms and 124ms on the same seeded fixture, while the engine arm moved
  // independently. Because the ratio was noisy, its floor was lowered four times
  // (3x -> 2x -> 1.1x -> 1.0) to stop it from flaking, and at 1.0 it asserted
  // nothing useful: it only required the engine not to be literally slower than a
  // full linear scan of the whole corpus. That ratio assertion and its
  // MIN_SPEEDUP constant are gone. The baseline arm itself stays — it still backs
  // the report-summary comparison above and the token-reduction gate below.
  //
  // Gate 1 — sublinear scaling. Compares the ENGINE arm to ITSELF at two corpus
  // sizes (750 records, then 3000 records — a 4x corpus), with no baseline
  // involved. If per-query work were proportional to corpus size, latency at 3000
  // records would be roughly 4x latency at 750. A candidate-bounded engine (the
  // intended design) stays close to 1x. The threshold of 2.2x sits between those:
  // loose enough to absorb fixed costs and run-to-run noise, tight enough to fail
  // if the #227 defect (an O(N) corpus read per query) comes back.
  //
  // Gate 2 — absolute catastrophe ceiling. Engine p50 at 3000 records must stay
  // under 60ms. This is deliberately loose. It does not police normal variation —
  // it exists only to catch a total blowup (e.g. the index silently going unused)
  // on any hardware, fast or slow.
  const SCALING_CEILING = 2.2;
  it('engine latency does not scale with corpus size (4x corpus stays within 2.2x latency)', () => {
    expect(engine.recordLatencyMsP50).toBeLessThanOrEqual(SCALING_CEILING * engineSmall.recordLatencyMsP50);
    expect(engine.recallLatencyMsP50).toBeLessThanOrEqual(SCALING_CEILING * engineSmall.recallLatencyMsP50);
  });

  const ABSOLUTE_CEILING_MS = 60;
  it('engine latency at 3000 records stays under an absolute catastrophe ceiling', () => {
    expect(engine.recordLatencyMsP50).toBeLessThan(ABSOLUTE_CEILING_MS);
    expect(engine.recallLatencyMsP50).toBeLessThan(ABSOLUTE_CEILING_MS);
  });

  it('engine injects >= 80% fewer record + recall tokens than the baseline corpus dump', () => {
    expect((baseline.recordTokenTotal - engine.recordTokenTotal) / baseline.recordTokenTotal).toBeGreaterThanOrEqual(0.8);
    expect((baseline.recallTokenTotal - engine.recallTokenTotal) / baseline.recallTokenTotal).toBeGreaterThanOrEqual(0.8);
  });
});
