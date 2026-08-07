import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCorpusAdapter } from '../../packages/core/src/journal/adapters/file-adapter.js';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';

// A minimal in-test adapter for the `records`/`records_fts` storage mode (see
// tests/journal/corpus-engine.test.ts) — `listFiles` returns a mutable array
// reference so a test can simulate a file disappearing from the corpus
// without needing real filesystem deletion for this storage mode.
function plainAdapter(root: string, files: string[]) {
  return {
    corpusId: 'plain',
    root,
    listFiles: async () => [...files],
    decode: async (relPath: string, raw: string) => ({ id: relPath, path: relPath, title: relPath, body: raw }),
    signals: () => [],
  };
}

it('drops a records-mode row when its file is removed before syncIncremental()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-deletion-records-'));
  await writeFile(join(root, 'a.txt'), 'alpha content');
  await writeFile(join(root, 'b.txt'), 'beta content');
  const files = ['a.txt', 'b.txt'];
  const index = await CorpusIndex.open({ root, adapter: plainAdapter(root, files) });
  await index.rebuild();
  expect(index.allRecords().map((r) => r.id).sort()).toEqual(['a.txt', 'b.txt']);

  // Remove b.txt from both disk and the adapter's file listing, then sync.
  await rm(join(root, 'b.txt'));
  files.splice(files.indexOf('b.txt'), 1);
  await index.syncIncremental();

  expect(index.allRecords().map((r) => r.id)).toEqual(['a.txt']);
  index.close();
});

it('drops a files/symbols-mode row (and its symbols) when its file is removed before syncIncremental()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-deletion-symbols-'));
  await writeFile(join(root, 'a.ts'), 'export function alpha() { return 1; }\n');
  await writeFile(join(root, 'b.ts'), 'export function beta() { return 2; }\n');
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }) });
  await index.rebuild();
  expect((await index.allFiles()).map((f) => f.filePath).sort()).toEqual(['a.ts', 'b.ts']);
  expect((await index.symbolsForFile('b.ts')).map((s) => s.name)).toEqual(['beta']);

  await rm(join(root, 'b.ts'));
  await index.syncIncremental();

  expect((await index.allFiles()).map((f) => f.filePath)).toEqual(['a.ts']);
  expect(await index.symbolsForFile('b.ts')).toEqual([]);
  expect((await index.allSymbols()).map((s) => s.name)).toEqual(['alpha']);
  index.close();
});
