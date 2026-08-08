/**
 * Deterministic, self-contained benchmark of the symbol-index candidate-bounded
 * path (`CorpusIndex.rankedSymbolsByTokens`) — the SYMBOL/FILE-side counterpart
 * to `benchmarks/journal/run.ts`'s record-side engine arm.
 *
 * There is no live LLM and no HTTP server here. This measures the REAL public
 * path the investigate preprocessor calls
 * (`packages/server/src/application/preprocessors/investigate.ts`):
 * `CorpusIndex.open` -> `ensureHealthy` -> `ensureFresh` ->
 * `rankedSymbolsByTokens`, against a seeded synthetic repository
 * (`./fixture.ts`) at a caller-supplied file count, using the SAME tokenizer
 * shape `investigate.ts` uses on a real prompt.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusIndex, FileCorpusAdapter } from '../../packages/core/src/journal/index.js';
import { generateSymbolFixture, writeSymbolFixture } from './fixture.js';

export interface SymbolBenchmarkOutput {
  fileCount: number;
  symbolCount: number;
  rankedLatencyMsP50: number;
}

const LATENCY_REPEATS = 20;
/** Mirrors the investigate preprocessor's own candidate cap (`CANDIDATE_CAP` in `investigate.ts`). */
const CANDIDATE_CAP = 20;
/**
 * Frozen prompt, tokenized exactly like `investigate.ts`'s own `tokenize()`
 * (lower-cased `[a-z0-9_]+` runs, deduped, length > 1) below — a natural-
 * language question whose filler words (`where`, `does`, `the`, `and`, ...)
 * are also common CODE vocabulary the fixture's COMMON_POOL reuses on
 * purpose, and whose content words (`ranked`, `candidate`, `symbol`, ...)
 * match the fixture's landmark file.
 */
const FROZEN_PROMPT = 'where does the corpus engine rank candidate symbols and return the ranked result';

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(matches.filter((token) => token.length > 1)));
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function runSymbolBenchmark(opts: { fileCount: number; seed: number }): Promise<SymbolBenchmarkOutput> {
  const root = mkdtempSync(join(tmpdir(), 'mma-symbol-bench-'));
  try {
    writeSymbolFixture(generateSymbolFixture({ seed: opts.seed, fileCount: opts.fileCount }), root);

    const adapter = new FileCorpusAdapter({ root });
    const index = await CorpusIndex.open({ root, adapter });
    try {
      await index.ensureHealthy();
      await index.ensureFresh();

      const tokens = tokenize(FROZEN_PROMPT);
      // Warm-up call: prepares/caches every statement this call path uses, so
      // the timed repeats below measure steady-state query cost, the same
      // reasoning `benchmarks/journal/run.ts` uses for its own latency loop.
      await index.rankedSymbolsByTokens(tokens, CANDIDATE_CAP);

      const latencies: number[] = [];
      for (let i = 0; i < LATENCY_REPEATS; i++) {
        const t0 = performance.now();
        await index.rankedSymbolsByTokens(tokens, CANDIDATE_CAP);
        latencies.push(performance.now() - t0);
      }

      const symbolCount = (await index.allSymbolsMeta()).length;
      return { fileCount: opts.fileCount, symbolCount, rankedLatencyMsP50: p50(latencies) };
    } finally {
      index.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
