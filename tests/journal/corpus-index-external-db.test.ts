import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';
import { FileCorpusAdapter } from '../../packages/core/src/journal/adapters/file-adapter.js';
import { JournalIndexStore } from '../../packages/core/src/journal/adapters/journal-adapter.js';

it('writes the derived database to a caller-supplied dbPath instead of <root>/index.db, leaving the corpus root clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-corpus-clean-root-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'mma-corpus-state-'));
  await writeFile(join(root, 'a.ts'), 'export function alpha() { return 1; }\n');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'b.ts'), 'export function beta() { return 2; }\n');

  const dbPath = join(stateRoot, 'corpus-index', 'a-deadbeefcafebabe.db');
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }), dbPath });
  await index.rebuild();
  index.close();

  // The database landed exactly where requested...
  expect(existsSync(dbPath)).toBe(true);
  // ...and nothing named index.db (or a WAL/SHM/journal sidecar) exists
  // anywhere under the indexed root.
  async function collectFileNames(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) names.push(...(await collectFileNames(join(dir, entry.name))));
      else names.push(entry.name);
    }
    return names;
  }
  const rootFileNames = await collectFileNames(root);
  expect(rootFileNames.some((name) => /^index\.db(-wal|-shm|-journal)?$/.test(name))).toBe(false);
});

it('keeps the default behavior unchanged when no dbPath override is given — the database still lands at <root>/index.db', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-corpus-default-db-'));
  await writeFile(join(root, 'a.ts'), 'export function alpha() { return 1; }\n');

  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }) });
  await index.rebuild();
  index.close();

  expect(existsSync(join(root, 'index.db'))).toBe(true);
});

it('indexes a user file literally named index.db as ordinary content when the derived database lives outside the corpus root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mma-corpus-user-index-db-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'mma-corpus-user-index-db-state-'));
  await writeFile(join(root, 'index.db'), 'plain text — a user file that happens to share the engine\'s default filename\n');

  const dbPath = join(stateRoot, 'corpus-index', 'root-cafebabedeadbeef.db');
  const index = await CorpusIndex.open({ root, adapter: new FileCorpusAdapter({ root }), dbPath });
  await index.rebuild();

  expect((await index.allFiles()).map((file) => file.filePath)).toContain('index.db');
  index.close();
});

it("keeps the journal's own index at <journalRoot>/index.db, unaffected by the code-corpus dbPath override", async () => {
  const journalRoot = await mkdtemp(join(tmpdir(), 'mma-journal-default-db-'));
  await mkdir(join(journalRoot, 'nodes'), { recursive: true });
  await writeFile(
    join(journalRoot, 'nodes', '0001-a.md'),
    '---\nid: "0001"\ntitle: "T"\ntype: "knowledge"\ntopic: "journal"\nstatus: "adopted"\ndescription: "d"\ntimestamp: "2026-08-07T00:00:00.000Z"\ntags:\n  []\nlinks:\n  []\nsupersededBy: null\n---\n\n## Context\n\nc\n\n## Consequences\n\nc\n',
  );

  const store = await JournalIndexStore.open({ journalRoot });
  await store.rebuildIndex();
  store.close();

  expect(existsSync(join(journalRoot, 'index.db'))).toBe(true);
});
