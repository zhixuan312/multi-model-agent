import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
