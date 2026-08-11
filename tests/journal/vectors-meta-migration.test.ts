import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalIndexStore, JOURNAL_INDEX_SCHEMA_VERSION, searchCandidatesForRecall } from '../../packages/core/src/journal/index.js';

it('rebuilds a same-version legacy database that still contains vectors_meta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-vector-migration-'));
  await mkdir(join(root, 'nodes'));
  await writeFile(join(root, 'nodes', '0001.md'), '---\nid: "0001"\ntitle: "Migration source"\ntype: "knowledge"\ntopic: "journal"\nstatus: "adopted"\ndescription: "migration"\ntimestamp: "2026-08-07T00:00:00.000Z"\ntags: [migration]\nlinks: []\nsupersededBy: null\n---\n\n## Context\n\nmigration\n\n## Consequences\n\nmigration\n');
  const legacy = new DatabaseSync(join(root, 'index.db'));
  legacy.exec(`CREATE TABLE documents (node_id TEXT PRIMARY KEY); CREATE TABLE vectors_meta (node_id TEXT PRIMARY KEY); PRAGMA user_version = ${JOURNAL_INDEX_SCHEMA_VERSION};`);
  legacy.close();
  const store = await JournalIndexStore.open({ journalRoot: root });
  await store.ensureHealthy();
  expect((await store.inspectSchema()).tables).not.toContain('vectors_meta');
  await expect(searchCandidatesForRecall(store, { prompt: 'migration', topic: 'journal', includeHistory: false }).then((r) => r.candidates.map((row) => row.nodeId))).resolves.toEqual(['0001']);
  store.close();
});