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
