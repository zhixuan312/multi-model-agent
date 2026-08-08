import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { CorpusIndex } from '@zhixuan92/multi-model-agent-core';
import { investigatePreprocessor } from '../../../../packages/server/src/application/preprocessors/investigate.js';

/** Minimal `PreprocessorArgs.config` stand-in — only `server.stateDir` is read. */
function configWithStateDir(stateDir: string) {
  return { server: { stateDir } } as never;
}

it('injects bounded indexed candidates and folder map before investigate starts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mma-investigate-preprocessor-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'mma-investigate-state-'));
  await mkdir(join(cwd, 'packages', 'core', 'src'), { recursive: true });
  await mkdir(join(cwd, 'packages', 'server', 'src'), { recursive: true });
  await writeFile(join(cwd, 'packages', 'core', 'src', 'index.ts'), 'export function searchIndex() { return "candidate"; }\n');
  await writeFile(join(cwd, 'packages', 'server', 'src', 'server.ts'), 'export class Server { investigate() {} }\n');
  const payload: Record<string, unknown> = { prompt: 'where does investigate search the index?' };
  await investigatePreprocessor({ cwd, payload, config: configWithStateDir(stateDir) } as never);
  const candidates = payload.candidates as Array<{ path: string; name: string; startLine: number; endLine: number; snippet: string }>;
  const folders = payload.folderMap as Array<{ folder: string; fileCount: number; symbolCount: number }>;
  expect(candidates).toHaveLength(2);
  expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'packages/core/src/index.ts', name: 'searchIndex', startLine: 1, endLine: 1 })]));
  expect(folders).toEqual(expect.arrayContaining([expect.objectContaining({ folder: 'packages/core/src', fileCount: 1, symbolCount: 1 })]));
  expect(JSON.stringify({ candidates, folders }).split(/\s+/).length).toBeLessThanOrEqual(4000);
});

it('never materializes symbol body text beyond the candidate cap, even when far more than the cap match', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mma-investigate-cap-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'mma-investigate-cap-state-'));
  await mkdir(join(cwd, 'src'), { recursive: true });
  // 25 matching symbols — more than CANDIDATE_CAP (20) — each in its own file
  // so ranking has real work to do before capping.
  const matchingFileCount = 25;
  for (let i = 0; i < matchingFileCount; i++) {
    const padded = String(i).padStart(2, '0');
    await writeFile(join(cwd, 'src', `target-${padded}.ts`), `export function targetFn${padded}() { return ${i}; }\n`);
  }

  const symbolsByIdsSpy = vi.spyOn(CorpusIndex.prototype, 'symbolsByIds');
  const allSymbolsSpy = vi.spyOn(CorpusIndex.prototype, 'allSymbols');
  const allSymbolsMetaSpy = vi.spyOn(CorpusIndex.prototype, 'allSymbolsMeta');
  try {
    const payload: Record<string, unknown> = { prompt: 'where is target defined?' };
    await investigatePreprocessor({ cwd, payload, config: configWithStateDir(stateDir) } as never);
    const candidates = payload.candidates as Array<{ path: string }>;

    // Capped at CANDIDATE_CAP even though 25 symbols matched.
    expect(candidates).toHaveLength(20);

    // The whole-corpus, full-body read path must never run: ranking uses
    // SQL to select the cap, and body is fetched exactly once, only for the
    // ids that survived. The folder map is likewise database-aggregated, so
    // it must not force a full metadata materialization either.
    expect(allSymbolsSpy).not.toHaveBeenCalled();
    expect(allSymbolsMetaSpy).not.toHaveBeenCalled();
    expect(symbolsByIdsSpy).toHaveBeenCalledTimes(1);
    expect(symbolsByIdsSpy.mock.calls[0]![0]).toHaveLength(20);
  } finally {
    symbolsByIdsSpy.mockRestore();
    allSymbolsSpy.mockRestore();
    allSymbolsMetaSpy.mockRestore();
  }
});

/** Recursively collect every file path under `dir`, relative to `dir`. */
async function listAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listAllFiles(full)).map((rel) => join(entry.name, rel)));
    } else {
      out.push(entry.name);
    }
  }
  return out;
}

it('leaves the corpus root clean — the derived index never lands inside the repository it indexes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mma-investigate-clean-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'mma-investigate-clean-state-'));
  await writeFile(join(cwd, 'a.ts'), 'export function alpha() { return 1; }\n');
  await investigatePreprocessor({ cwd, payload: { prompt: 'alpha' }, config: configWithStateDir(stateDir) } as never);

  const rootFiles = await listAllFiles(cwd);
  expect(rootFiles.some((f) => /(^|\/)index\.db(-wal|-shm|-journal)?$/.test(f))).toBe(false);
});

it('resolves two different spellings of the same repository root to the same index file', async () => {
  const realCwd = await mkdtemp(join(tmpdir(), 'mma-investigate-real-root-'));
  await writeFile(join(realCwd, 'a.ts'), 'export function alpha() { return 1; }\n');
  const linkParent = await mkdtemp(join(tmpdir(), 'mma-investigate-link-parent-'));
  const symlinkCwd = join(linkParent, 'repo-link');
  await symlink(realCwd, symlinkCwd, 'dir');
  const stateDir = await mkdtemp(join(tmpdir(), 'mma-investigate-dedup-state-'));

  await investigatePreprocessor({ cwd: realCwd, payload: { prompt: 'alpha' }, config: configWithStateDir(stateDir) } as never);
  await investigatePreprocessor({ cwd: symlinkCwd, payload: { prompt: 'alpha' }, config: configWithStateDir(stateDir) } as never);

  const dbFiles = (await readdir(join(stateDir, 'corpus-index'))).filter((name) => name.endsWith('.db'));
  expect(dbFiles).toHaveLength(1);
});
