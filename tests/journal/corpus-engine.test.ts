import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';

// A minimal in-test adapter proves the engine is corpus-neutral: it knows
// nothing about journals, topics, status, or typed edges.
const plainAdapter = (root: string) => ({
  corpusId: 'plain',
  root,
  listFiles: async () => ['a.txt', 'b.txt'],
  decode: async (relPath: string, raw: string) => ({ id: relPath, path: relPath, title: relPath, body: raw }),
  signals: () => [],
});

it('rebuilds, searches by RRF, and incrementally re-syncs only changed records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-corpus-engine-'));
  await writeFile(join(root, 'a.txt'), 'alpha retrieval engine');
  await writeFile(join(root, 'b.txt'), 'beta unrelated material');
  const index = await CorpusIndex.open({ root, adapter: plainAdapter(root) });
  await index.rebuild();

  expect((await index.inspectSchema()).tables).toEqual(expect.arrayContaining(['records', 'records_fts']));
  expect((await index.search(['retrieval'])).map((row) => row.id)).toEqual(['a.txt']);

  await writeFile(join(root, 'a.txt'), 'alpha rewritten completely');
  await index.syncIncremental();
  expect((await index.search(['retrieval'])).map((row) => row.id)).toEqual([]);
  expect((await index.search(['rewritten'])).map((row) => row.id)).toEqual(['a.txt']);
  index.close();
});

it('ranks record metadata before materializing returned bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-corpus-engine-meta-search-'));
  await writeFile(join(root, 'a.txt'), 'alpha retrieval engine');
  await writeFile(join(root, 'b.txt'), 'beta unrelated material');
  const index = await CorpusIndex.open({ root, adapter: plainAdapter(root) });
  await index.rebuild();

  vi.spyOn(index, 'allRecords').mockImplementation(() => {
    throw new Error('ranking must not materialize every record body');
  });

  await expect(index.search(['retrieval'])).resolves.toMatchObject([{ id: 'a.txt', body: 'alpha retrieval engine' }]);
  index.close();
});
