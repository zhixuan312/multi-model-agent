import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { FileCorpusAdapter } from '../../packages/core/src/journal/adapters/file-adapter.js';
import { listGitTrackedFiles } from '../../packages/core/src/journal/engine/freshness.js';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';

// Controllable `fs/promises.realpath` stub: passes through to the real
// implementation for every path, EXCEPT that once `raceControl.swapPath` is
// armed, the FIRST time `realpath` resolves that exact path it also swaps
// the file at that path for a symlink to `raceControl.swapTarget` — after
// computing the (pre-swap) realpath result, but before returning it. This
// simulates the TOCTOU (time-of-check-to-time-of-use) race the O_NOFOLLOW
// fix closes: `isSafeGitReportedFile`'s realpath-based validation observes
// the file while it is still a validated regular file, but the object on
// disk changes underneath before the subsequent read.
const raceControl = vi.hoisted(() => ({ swapPath: null as string | null, swapTarget: null as string | null, swapped: false }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
      const result = await (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest);
      if (!raceControl.swapped && raceControl.swapPath !== null && path === raceControl.swapPath) {
        raceControl.swapped = true;
        await actual.rm(raceControl.swapPath);
        await actual.symlink(raceControl.swapTarget!, raceControl.swapPath);
      }
      return result;
    },
  };
});

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

it('never dereferences a tracked symlink pointing outside the corpus root via the git fast path', async () => {
  const secretRoot = await mkdtemp(join(tmpdir(), 'mma-secret-'));
  const secretPath = join(secretRoot, 'secret.txt');
  await writeFile(secretPath, 'TOP-SECRET-HOST-FILE-CONTENT');

  const gitRoot = await mkdtemp(join(tmpdir(), 'mma-symlink-git-'));
  execFileSync('git', ['init', '-q', gitRoot]);
  await symlink(secretPath, join(gitRoot, 'linked.txt'));
  execFileSync('git', ['-C', gitRoot, 'add', 'linked.txt']);
  execFileSync('git', ['-C', gitRoot, '-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-qm', 'seed']);

  // A fresh, empty index: `ensureFresh()` takes the sublinear git path and
  // (pre-fix) fed the tracked symlink straight to `readFile`, which
  // dereferences it — reading and indexing the EXTERNAL file's content.
  const index = await CorpusIndex.open({ root: gitRoot, adapter: new FileCorpusAdapter({ root: gitRoot }) });
  await index.ensureFresh();

  expect(await index.symbolsForFile('linked.txt')).toEqual([]);
  const everySymbol = await index.allSymbols();
  expect(everySymbol.some((symbol) => symbol.body.includes('TOP-SECRET-HOST-FILE-CONTENT'))).toBe(false);
  index.close();
});

it('prepares git-reported file changes before acquiring the SQLite writer transaction', async () => {
  const gitRoot = await mkdtemp(join(tmpdir(), 'mma-git-transaction-'));
  execFileSync('git', ['init', '-q', gitRoot]);
  await writeFile(join(gitRoot, 'entry.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', gitRoot, 'add', 'entry.ts']);
  execFileSync('git', ['-C', gitRoot, '-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-qm', 'seed']);

  let observeExtraction = false;
  let beganDuringExtraction = false;
  const beginSpy = vi.spyOn(DatabaseSync.prototype, 'exec');
  const adapter = new FileCorpusAdapter({ root: gitRoot });
  const originalExtract = adapter.extractSymbols.bind(adapter);
  adapter.extractSymbols = async (relPath, raw) => {
    if (observeExtraction) beganDuringExtraction ||= beginSpy.mock.calls.some(([sql]) => sql === 'BEGIN');
    return originalExtract(relPath, raw);
  };
  const index = await CorpusIndex.open({ root: gitRoot, adapter });
  await index.ensureFresh();

  await writeFile(join(gitRoot, 'entry.ts'), 'export const value = 2;\n');
  beginSpy.mockClear();
  observeExtraction = true;
  await index.ensureFresh();

  expect(beganDuringExtraction).toBe(false);
  beginSpy.mockRestore();
  index.close();
});

it('preserves unusual tracked filenames without git C-style escape text', async () => {
  const gitRoot = await mkdtemp(join(tmpdir(), 'mma-git-unusual-name-'));
  const unusualName = 'unusual-💡\nname.ts';
  execFileSync('git', ['init', '-q', gitRoot]);
  await writeFile(join(gitRoot, unusualName), 'export const unusual = true;\n');
  execFileSync('git', ['-C', gitRoot, 'add', unusualName]);

  await expect(listGitTrackedFiles(gitRoot)).resolves.toEqual([unusualName]);
});

it('indexes a tracked file inside a directory whose name starts with ".." rather than rejecting it as a traversal attempt', async () => {
  const gitRoot = await mkdtemp(join(tmpdir(), 'mma-dotdot-dir-'));
  execFileSync('git', ['init', '-q', gitRoot]);
  await mkdir(join(gitRoot, '..generated'), { recursive: true });
  await writeFile(join(gitRoot, '..generated', 'file.ts'), 'export function inDotDotDir() {}\n');
  execFileSync('git', ['-C', gitRoot, 'add', '..generated/file.ts']);
  execFileSync('git', ['-C', gitRoot, '-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-qm', 'seed']);

  const index = await CorpusIndex.open({ root: gitRoot, adapter: new FileCorpusAdapter({ root: gitRoot }) });
  await index.ensureFresh();

  expect((await index.symbolsForFile('..generated/file.ts')).map((symbol) => symbol.name)).toEqual(['inDotDotDir']);
  index.close();
});

it('never indexes external content when a validated file is swapped for a symlink between validation and read (TOCTOU)', async () => {
  const secretRoot = await mkdtemp(join(tmpdir(), 'mma-toctou-secret-'));
  const secretPath = join(secretRoot, 'secret.txt');
  await writeFile(secretPath, 'TOP-SECRET-RACE-CONTENT');

  const gitRoot = await mkdtemp(join(tmpdir(), 'mma-toctou-git-'));
  execFileSync('git', ['init', '-q', gitRoot]);
  const racePath = join(gitRoot, 'race.ts');
  await writeFile(racePath, 'export function original() {}\n');
  execFileSync('git', ['-C', gitRoot, 'add', 'race.ts']);
  execFileSync('git', ['-C', gitRoot, '-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-qm', 'seed']);

  // Arm the race: the NEXT time `isSafeGitReportedFile`'s realpath check
  // resolves `race.ts`'s canonical path (i.e. right after validation deems
  // it a safe regular file), swap the file for a symlink pointing outside
  // the corpus root — simulating a concurrent process with repo-write access
  // winning the race between validation and the subsequent read.
  raceControl.swapPath = racePath;
  raceControl.swapTarget = secretPath;
  raceControl.swapped = false;

  const index = await CorpusIndex.open({ root: gitRoot, adapter: new FileCorpusAdapter({ root: gitRoot }) });
  await index.ensureFresh();

  // O_NOFOLLOW makes the open fail once the file is a symlink, so the swap
  // is treated like an unreadable/vanished file: skipped, never indexed.
  expect(raceControl.swapped).toBe(true);
  expect(await index.symbolsForFile('race.ts')).toEqual([]);
  const everySymbol = await index.allSymbols();
  expect(everySymbol.some((symbol) => symbol.body.includes('TOP-SECRET-RACE-CONTENT'))).toBe(false);
  index.close();
});
