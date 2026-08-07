import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCorpusAdapter } from '../../packages/core/src/journal/adapters/file-adapter.js';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';

it('uses git change metadata without a full stat sweep and throttles non-git fallback sweeps', async () => {
  const gitRoot = await mkdtemp(join(tmpdir(), 'mma-fresh-git-'));
  execFileSync('git', ['init', '-q', gitRoot]);
  await writeFile(join(gitRoot, 'a.ts'), 'export function one() {}\n');
  execFileSync('git', ['-C', gitRoot, 'add', 'a.ts']);
  execFileSync('git', ['-C', gitRoot, '-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-qm', 'seed']);
  const gitIndex = await CorpusIndex.open({ root: gitRoot, adapter: new FileCorpusAdapter({ root: gitRoot }) });
  await gitIndex.rebuild();
  await writeFile(join(gitRoot, 'a.ts'), 'export function two() {}\n');
  await gitIndex.ensureFresh();
  expect((await gitIndex.symbolsForFile('a.ts')).map((row) => row.name)).toEqual(['two']);
  expect(gitIndex.lastFreshnessDecision()).toMatchObject({ mode: 'git', statSweep: false, changedPaths: ['a.ts'] });

  const plainRoot = await mkdtemp(join(tmpdir(), 'mma-fresh-plain-'));
  await writeFile(join(plainRoot, 'a.txt'), 'one');
  const plainIndex = await CorpusIndex.open({ root: plainRoot, adapter: new FileCorpusAdapter({ root: plainRoot }), fallbackSweepIntervalMs: 60_000 });
  await plainIndex.rebuild();
  await plainIndex.ensureFresh();
  await plainIndex.ensureFresh();
  expect(plainIndex.lastFreshnessDecision()).toMatchObject({ mode: 'stat', sweepCount: 1 });
  gitIndex.close(); plainIndex.close();
});