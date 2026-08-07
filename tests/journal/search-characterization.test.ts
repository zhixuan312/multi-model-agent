import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalIndexStore, searchCandidatesForRecall } from '../../packages/core/src/journal/index.js';

// NOTE: node-codec.ts:124 throws 'Superseded nodes require supersededBy' — a
// superseded fixture node MUST carry a non-null supersededBy or the corpus
// fails to parse and this baseline cannot run at all.
const node = (id: string, title: string, topic: string, status: string, tags: string[], links: string, body: string, supersededBy: string | null = null) => `---\nid: "${id}"\ntitle: "${title}"\ntype: "knowledge"\ntopic: "${topic}"\nstatus: "${status}"\ndescription: "${body}"\ntimestamp: "2026-08-07T00:00:00.000Z"\ntags:\n${tags.map((tag) => `  - ${tag}`).join('\n')}\nlinks:\n${links}\nsupersededBy: ${supersededBy === null ? 'null' : `"${supersededBy}"`}\n---\n\n## Context\n\n${body}\n\n## Consequences\n\n${body}\n`;

async function corpus() {
  const root = await mkdtemp(join(tmpdir(), 'mma-journal-characterization-'));
  await mkdir(join(root, 'nodes'));
  await writeFile(join(root, 'nodes', '0001-index.md'), node('0001', 'Index refresh', 'engine', 'adopted', ['index', 'refresh'], '  []', 'Refresh protects lexical retrieval.'));
  await writeFile(join(root, 'nodes', '0002-history.md'), node('0002', 'Old refresh', 'engine', 'superseded', ['refresh'], '  []', 'Historical refresh answer.', '0001'));
  await writeFile(join(root, 'nodes', '0003-links.md'), node('0003', 'Retrieval neighbor', 'engine', 'adopted', ['retrieval'], '  - type: "refines"\n    target: "0001"', 'Neighbor evidence.'));
  await writeFile(join(root, 'nodes', '0004-other.md'), node('0004', 'Other topic', 'other', 'adopted', ['unrelated'], '  []', 'Unrelated material.'));
  return root;
}

it('pins current node IDs and order for fixed recall queries', async () => {
  const root = await corpus();
  const store = await JournalIndexStore.open({ journalRoot: root });
  await store.rebuildIndex();
  await expect(searchCandidatesForRecall(store, { prompt: 'index refresh retrieval', topic: 'engine', includeHistory: false }).then((rows) => rows.map((row) => row.nodeId))).resolves.toEqual(['0001', '0003']);
  await expect(searchCandidatesForRecall(store, { prompt: 'refresh', topic: 'engine', includeHistory: true }).then((rows) => rows.map((row) => row.nodeId))).resolves.toEqual(['0001', '0002']);
  store.close();
});