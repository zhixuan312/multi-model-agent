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
 * arm involved. LINEAR would be 4x. The defect measured 3.9x. This gate fails
 * if the ratio climbs back toward linear.
 *
 * The threshold is 3.0x, NOT the journal gate's 2.2x, and the difference is
 * deliberate. 2.2x was tried first and was wrong: it assumed candidate-bounded
 * means FLAT, which is true of the journal but not here. The journal prefilters
 * on indexed `topic`/`status` columns, so a query touches only its topic's
 * rows. A symbol query has no such partition — FTS5 must still scan and rank
 * every MATCHING row to pick the top N, and the number of matches grows with
 * the repository even though the rows crossing into JavaScript do not. Some
 * growth is therefore correct behaviour, not a defect.
 *
 * Measured: 3.9x before the fix, ~2.2x on a laptop after it, 2.58x on a
 * GitHub runner. 2.2 sat inside that spread and failed the release on hardware
 * variance. 3.0 sits clearly below linear while absorbing it.
 *
 * The absolute ceiling below is what actually pins a catastrophic regression,
 * since a ratio between two small timings is the weaker of the two signals.
 */
describe('symbol index benchmark gates', () => {
  let small: SymbolBenchmarkOutput;
  let large: SymbolBenchmarkOutput;

  beforeAll(async () => {
    small = await runSymbolBenchmark({ fileCount: 150, seed: 42 });
    large = await runSymbolBenchmark({ fileCount: 600, seed: 42 });
  }, 60_000);

  const SCALING_CEILING = 3.0;
  const ABSOLUTE_CEILING_MS = 60;
  it('rankedSymbolsByTokens stays sublinear as the corpus grows (4x corpus, linear would be 4x)', () => {
    expect(large.symbolCount).toBeGreaterThan(small.symbolCount);
    expect(large.rankedLatencyMsP50).toBeLessThanOrEqual(SCALING_CEILING * small.rankedLatencyMsP50);
  });

  it('rankedSymbolsByTokens stays under an absolute catastrophe ceiling', () => {
    expect(large.rankedLatencyMsP50).toBeLessThan(ABSOLUTE_CEILING_MS);
  });
});
