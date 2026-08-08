import { beforeAll, describe, expect, it } from 'vitest';
import { runSymbolBenchmark, type SymbolBenchmarkOutput } from '../../benchmarks/symbol-index/run.js';

/**
 * G-2 gate: the SYMBOL/FILE-side counterpart to `journal-engine-benchmark-
 * gates.test.ts`'s G-1 sublinear-scaling gate, for `CorpusIndex.
 * rankedSymbolsByTokens` (the ranking entry point the investigate
 * preprocessor uses).
 *
 * What broke, measured before this fix: per-query engine work was
 * proportional to CORPUS SIZE rather than to the CANDIDATE SET a query
 * returns — a whole-`symbols`-table `LIKE` score computed for every row on
 * every call, the same class of defect #227/#233 removed from the journal
 * side. Measured against this repository's own real source (150 vs 600
 * files, same tokenized natural-language prompt): 8.4ms -> 21.7ms, roughly
 * 2.6x latency for a 4x corpus. That is a property of the algorithm, not of
 * the machine running it, so — same reasoning as the journal gate — it is
 * gated directly here rather than against a noisy wall-clock baseline
 * comparison, and cannot be flaked by CI hardware being faster or slower
 * than a laptop.
 *
 * Gate — sublinear scaling. Compares `rankedSymbolsByTokens` to ITSELF at two
 * corpus sizes (150 files, then 600 files — a 4x corpus) against the seeded
 * synthetic fixture in `benchmarks/symbol-index/fixture.ts`, with no baseline
 * arm involved. If per-query work were proportional to corpus size, latency
 * at 600 files would be roughly 4x latency at 150. A candidate-bounded engine
 * (the intended design, after this fix) stays close to 1x. The threshold of
 * 2.2x — identical to the journal gate's own threshold, for the same reason —
 * sits between those: loose enough to absorb fixed costs and run-to-run
 * noise, tight enough to fail if the O(corpus) whole-table scan defect comes
 * back.
 */
describe('symbol index benchmark gates', () => {
  let small: SymbolBenchmarkOutput;
  let large: SymbolBenchmarkOutput;

  beforeAll(async () => {
    small = await runSymbolBenchmark({ fileCount: 150, seed: 42 });
    large = await runSymbolBenchmark({ fileCount: 600, seed: 42 });
  }, 60_000);

  const SCALING_CEILING = 2.2;
  it('rankedSymbolsByTokens latency does not scale with corpus size (4x corpus stays within 2.2x latency)', () => {
    expect(large.symbolCount).toBeGreaterThan(small.symbolCount);
    expect(large.rankedLatencyMsP50).toBeLessThanOrEqual(SCALING_CEILING * small.rankedLatencyMsP50);
  });
});
