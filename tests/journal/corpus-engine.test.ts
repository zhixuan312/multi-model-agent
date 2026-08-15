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
});

/** Ids the engine's lexical probe returns for `tokens`, best-first. */
const lexicalIds = (index: CorpusIndex, tokens: string[]) =>
  index.lexicalSearch(tokens).map((hit) => hit.id);

/**
 * Observed through `lexicalSearch` + `recordsByIds` — the API the journal adapter actually
 * calls. These used to go through `CorpusIndex.search()`, which fused adapter signal lists via
 * RRF in `engine/search.ts`; that path had no production caller (the adapter runs its own
 * candidate-bounded fusion) and this file was the only thing keeping it alive. What is under
 * test here — rebuild, incremental re-sync, and ranking without materializing bodies — is
 * unchanged.
 */
it('rebuilds, indexes lexically, and incrementally re-syncs only changed records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-corpus-engine-'));
  await writeFile(join(root, 'a.txt'), 'alpha retrieval engine');
  await writeFile(join(root, 'b.txt'), 'beta unrelated material');
  const index = await CorpusIndex.open({ root, adapter: plainAdapter(root) });
  await index.rebuild();

  expect((await index.inspectSchema()).tables).toEqual(expect.arrayContaining(['records', 'records_fts']));
  expect(lexicalIds(index, ['retrieval'])).toEqual(['a.txt']);

  await writeFile(join(root, 'a.txt'), 'alpha rewritten completely');
  await index.syncIncremental();
  expect(lexicalIds(index, ['retrieval'])).toEqual([]);
  expect(lexicalIds(index, ['rewritten'])).toEqual(['a.txt']);
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

  // Rank first (ids + metadata only), then fetch bodies for just the winners — `allRecords`
  // must never be reached, which is what the spy above asserts.
  const ranked = lexicalIds(index, ['retrieval']);
  expect(ranked).toEqual(['a.txt']);
  expect(index.recordsByIds(ranked)).toMatchObject([{ id: 'a.txt', body: 'alpha retrieval engine' }]);
  index.close();
});
