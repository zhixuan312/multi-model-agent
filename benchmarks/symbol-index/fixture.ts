/**
 * Synthetic TypeScript-like source corpus generator for the symbol-index
 * candidate-bounded benchmark (`tests/perf/symbol-index-benchmark-gates.test.ts`).
 *
 * The fixture is fully deterministic: the same `{ seed, fileCount }` always
 * yields byte-identical file contents (seeded mulberry32 RNG, no clock, no
 * `Math.random`) — same reasoning and same RNG as
 * `benchmarks/journal/fixture-3000.ts`.
 *
 * Every generated function body deliberately reuses a small COMMON_POOL of
 * real TypeScript keywords (`function`, `return`, `export`, `const`, `if`)
 * that appear in nearly every function in a real repository — this is what
 * made the measured real-repo defect linear in the first place (see the
 * `rankedSymbolsByTokens` doc comments in `packages/core/src/journal/engine/
 * index-store.ts`): a natural-language investigate prompt tokenizes into
 * common English words that also happen to be common CODE vocabulary, so a
 * substring search for them legitimately matches a large, corpus-size-scaling
 * fraction of every file. Each file also gets a handful of RARE,
 * file-specific identifiers so a query can still land genuinely-relevant,
 * high-scoring candidates alongside that common-vocabulary noise.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Deterministic RNG — same seed → identical stream (same generator as the journal fixture). */
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

/** Common code vocabulary — present in nearly every generated function body, by design. */
const COMMON_POOL = ['function', 'return', 'export', 'const', 'value', 'result', 'input', 'data'];

/** Rare, file-specific vocabulary pool a landmark query's tokens are drawn from. */
const RARE_POOL = [
  'ranked',
  'candidate',
  'engine',
  'corpus',
  'symbol',
  'trigram',
  'narrow',
  'ledger',
  'quartz',
  'obsidian',
  'zephyr',
  'meridian',
];

const FUNCTIONS_PER_FILE = 3;

export interface SymbolFixtureFile {
  relPath: string;
  content: string;
}

/**
 * Generate `fileCount` deterministic `.ts` files, each with {@link
 * FUNCTIONS_PER_FILE} small functions. One file (`landmark.ts`) always
 * carries the frozen rare vocabulary the benchmark's frozen prompt (see
 * `run.ts`) targets, so the benchmark exercises a REAL candidate — not only
 * common-vocabulary noise — at every corpus size.
 */
export function generateSymbolFixture(opts: { seed: number; fileCount: number }): SymbolFixtureFile[] {
  const { seed, fileCount } = opts;
  const rand = mulberry32(seed);
  const files: SymbolFixtureFile[] = [];

  files.push({
    relPath: 'src/landmark.ts',
    content: [
      'export function rankedCandidateSymbol() {',
      '  // The corpus engine ranks symbols by trigram candidate narrowing.',
      '  const result = "candidate";',
      '  return result;',
      '}',
      '',
    ].join('\n'),
  });

  for (let f = 0; f < fileCount; f++) {
    const lines: string[] = [];
    for (let g = 0; g < FUNCTIONS_PER_FILE; g++) {
      const rare = RARE_POOL[Math.floor(rand() * RARE_POOL.length)];
      const name = `${rare}Fn${f}_${g}`;
      const common = COMMON_POOL[Math.floor(rand() * COMMON_POOL.length)];
      lines.push(`export function ${name}() {`);
      lines.push(`  const value = ${f + g};`);
      lines.push(`  // ${common} handling for ${rare}`);
      lines.push(`  return value;`);
      lines.push(`}`);
      lines.push('');
    }
    files.push({ relPath: `src/pkg${f}/file${f}.ts`, content: lines.join('\n') });
  }

  return files;
}

export function writeSymbolFixture(files: SymbolFixtureFile[], root: string): void {
  for (const file of files) {
    const fullPath = join(root, file.relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf8');
  }
}
