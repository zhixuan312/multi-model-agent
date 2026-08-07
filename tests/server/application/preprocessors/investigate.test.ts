import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
