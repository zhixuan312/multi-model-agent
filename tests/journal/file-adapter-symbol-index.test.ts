import { mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';
import { FileCorpusAdapter } from '../../packages/core/src/journal/adapters/file-adapter.js';

it('extracts three tiers and replaces all symbols when one source file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-file-corpus-'));
  await writeFile(join(root, 'guide.md'), '# First\nalpha\n# Second\nbeta\n');
  await writeFile(join(root, 'source.ts'), 'export function alpha() { return 1; }\nexport class Beta { run() { return 2; } }\n');
  await writeFile(join(root, 'blob.txt'), Array.from({ length: 201 }, (_, i) => `line ${i + 1}`).join('\n'));
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }) });
  await index.rebuild();
  expect(await index.symbolsForFile('guide.md')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'First', kind: 'heading', startLine: 1 }), expect.objectContaining({ name: 'Second', kind: 'heading', startLine: 3 })]));
  expect(await index.symbolsForFile('source.ts')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'alpha', kind: 'function' }), expect.objectContaining({ name: 'Beta', kind: 'class' })]));
  expect(await index.symbolsForFile('blob.txt')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'block', startLine: 1, endLine: 200 }), expect.objectContaining({ kind: 'block', startLine: 201, endLine: 201 })]));
  await writeFile(join(root, 'source.ts'), 'export function gamma() { return 3; }\n');
  await index.syncIncremental();
  expect((await index.symbolsForFile('source.ts')).map((symbol) => symbol.name)).toEqual(['gamma']);
  index.close();
});

it('re-prepares a file that changes during the pre-transaction preparation window instead of committing a stale hash/body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-drift-prepare-'));
  const filePath = join(root, 'drift.ts');
  await writeFile(filePath, 'export function stale() { return 1; }\n');
  const before = await stat(filePath);

  const adapter = new FileCorpusAdapter({ root });
  const originalExtract = adapter.extractSymbols.bind(adapter);
  let mutated = false;
  // `extractSymbols` runs during preparation, entirely before the write
  // transaction opens. Mutate the file's content (and force a distinct
  // mtime, independent of filesystem timestamp resolution) here to simulate
  // a concurrent writer changing — and possibly committing — the file DURING
  // this preparation window, after its stale content was already read.
  adapter.extractSymbols = async (relPath, raw) => {
    if (relPath === 'drift.ts' && !mutated) {
      mutated = true;
      await writeFile(filePath, 'export function fresh() { return 2; }\n');
      await utimes(filePath, new Date(before.mtimeMs + 60_000), new Date(before.mtimeMs + 60_000));
    }
    return originalExtract(relPath, raw);
  };

  const index = await CorpusIndex.open({ root, adapter });
  await index.rebuild();

  // Pre-fix: the transaction would commit the STALE `stale()` snapshot read
  // before the mutation, and a subsequently clean `git status`/mtime match
  // would never trigger a refresh. Post-fix: the re-stat immediately before
  // the write transaction detects the drift and re-prepares the file, so the
  // FRESH content is what actually gets committed.
  expect((await index.symbolsForFile('drift.ts')).map((symbol) => symbol.name)).toEqual(['fresh']);
  index.close();
});

// Regression: a bounded-fanout optimisation once capped the number of TOKENS
// searched rather than the number of RESULTS returned. It sorted tokens by
// rarity and stopped once their cumulative match count exceeded the limit, so a
// rare token paired with a common one caused the common token to be dropped
// entirely — its symbols never became candidates and never appeared in the
// result. The cap belongs on results, not on tokens.
it('keeps every query token in play — a rare token must not suppress a common one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-symbol-tokens-'));
  // One symbol matches the rare token; 21 match the common token.
  await writeFile(join(root, 'rare.ts'), 'export function needleFn() { return 1; }\n');
  for (let i = 0; i < 21; i++) {
    await writeFile(join(root, `common${i}.ts`), `export function commonFn${i}() { return ${i}; }\n`);
  }
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }) });
  await index.rebuild();

  // 'needle' is rare (1 hit); 'return' is common (all 22 bodies). Their combined
  // match count exceeds the limit, which is exactly the condition that made the
  // old rarity-prefix loop discard the common token.
  const ranked = await index.rankedSymbolsByTokens(['needle', 'return'], 20);
  const names = ranked.map((symbol) => symbol.name);

  // The rare match scores highest (name hit + body hit) and must rank first.
  expect(names[0]).toBe('needleFn');
  // The common token must ALSO have been searched. Before the fix it was dropped
  // entirely and this returned ['needleFn'] alone.
  expect(names.filter((name) => name.startsWith('commonFn')).length).toBeGreaterThan(0);
  // The LIMIT — not the token count — is what bounds the result.
  expect(ranked.length).toBe(20);
  index.close();
});
