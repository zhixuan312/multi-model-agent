import { mkdtemp, writeFile } from 'node:fs/promises';
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