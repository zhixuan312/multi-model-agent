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
  await expect(searchCandidatesForRecall(store, { prompt: 'engine health', topic: 'journal', includeHistory: false }).then((rows) => rows.map((row) => row.nodeId))).resolves.toEqual(['0001']);
  store.close();
});