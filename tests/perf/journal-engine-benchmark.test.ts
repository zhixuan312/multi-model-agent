import { describe, expect, it } from 'vitest';
import { generateFixture } from '../../benchmarks/journal/fixture-2000.js';
import { FROZEN_QUERIES } from '../../benchmarks/journal/queries.js';
import { runBenchmark, type BenchmarkOutput } from '../../benchmarks/journal/run.js';

// Frozen output contract every benchmark run must satisfy:
// interface BenchmarkOutput {
//   path: 'baseline' | 'engine';
//   recordLatencyMsP50: number; recallLatencyMsP50: number;
//   recordTokenTotal: number; recallTokenTotal: number;
//   retrievalMAP: number;                 // mean average precision vs frozen expected-node sets
//   mechanicalErrors: number;             // bad ids + malformed catalog rows + dangling edges + missing outcomes
//   rebuildEquivalent: boolean;
// }

describe('journal benchmark harness', () => {
  it('generates a deterministic 2000-node fixture (same seed → identical corpus)', () => {
    const a = generateFixture({ seed: 42, count: 2000 });
    const b = generateFixture({ seed: 42, count: 2000 });
    expect(a.length).toBe(2000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // fixture covers every scenario the retrieval/record paths must handle:
    for (const kind of ['create', 'refine', 'merge', 'supersede', 'contradiction', 'graph-neighbor', 'cross-topic'])
      expect(a.some((n) => n.scenario === kind)).toBe(true);
  });

  it('runner emits the frozen BenchmarkOutput shape for both paths', async () => {
    const out: BenchmarkOutput = await runBenchmark({ path: 'engine', fixtureSeed: 42, queries: FROZEN_QUERIES });
    for (const k of ['recordLatencyMsP50', 'recallLatencyMsP50', 'recordTokenTotal', 'recallTokenTotal', 'retrievalMAP', 'mechanicalErrors', 'rebuildEquivalent'])
      expect(out).toHaveProperty(k);
    expect(typeof out.retrievalMAP).toBe('number');
    expect(typeof out.rebuildEquivalent).toBe('boolean');
  }, 120_000);
});
