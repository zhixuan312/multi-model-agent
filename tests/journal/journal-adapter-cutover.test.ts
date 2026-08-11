import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalIndexStore, searchCandidatesForRecall } from '../../packages/core/src/journal/index.js';

it('serves the unchanged journal search API from the corpus-neutral engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-journal-cutover-'));
  await mkdir(join(root, 'nodes'));
  await writeFile(join(root, 'nodes', '0001-a.md'), '---\nid: "0001"\ntitle: "Engine health"\ntype: "knowledge"\ntopic: "journal"\nstatus: "adopted"\ndescription: "engine health"\ntimestamp: "2026-08-07T00:00:00.000Z"\ntags:\n  - engine\nlinks:\n  []\nsupersededBy: null\n---\n\n## Context\n\nengine health\n\n## Consequences\n\nengine health\n');
  const store = await JournalIndexStore.open({ journalRoot: root });
  await store.rebuildIndex();
  expect((await store.inspectSchema()).tables).toEqual(expect.arrayContaining(['records', 'records_fts']));
  expect((await store.inspectSchema()).tables).not.toContain('documents');
  await expect(searchCandidatesForRecall(store, { prompt: 'engine health', topic: 'journal', includeHistory: false }).then((r) => r.candidates.map((row) => row.nodeId))).resolves.toEqual(['0001']);
  store.close();
});

// The engine serves ONE storage mode. `files`, `symbols` and `symbols_trgm`
// belonged to the deleted code index, and the journal never read them — but the
// engine used to create them on any adapter it decided was symbol-shaped, so the
// journal paid for their creation and maintenance. Assert their absence on both
// paths that can write schema: a first open, and the drop-and-recreate rebuild.
it('creates no code-index tables, on a fresh open or a rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-journal-tables-'));
  await mkdir(join(root, 'nodes'));
  await writeFile(join(root, 'nodes', '0001-a.md'), '---\nid: "0001"\ntitle: "Engine health"\ntype: "knowledge"\ntopic: "journal"\nstatus: "adopted"\ndescription: "engine health"\ntimestamp: "2026-08-07T00:00:00.000Z"\ntags:\n  - engine\nlinks:\n  []\nsupersededBy: null\n---\n\n## Context\n\nengine health\n\n## Consequences\n\nengine health\n');
  const store = await JournalIndexStore.open({ journalRoot: root });

  const codeIndexTables = ['files', 'symbols', 'symbols_trgm'];
  const onOpen = (await store.inspectSchema()).tables;
  for (const table of codeIndexTables) expect(onOpen).not.toContain(table);

  await store.rebuildIndex();
  const afterRebuild = (await store.inspectSchema()).tables;
  for (const table of codeIndexTables) expect(afterRebuild).not.toContain(table);

  store.close();
});