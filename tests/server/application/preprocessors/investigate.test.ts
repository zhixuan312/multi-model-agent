import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { investigatePreprocessor } from '../../../../packages/server/src/application/preprocessors/investigate.js';

it('injects bounded indexed candidates and folder map before investigate starts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mma-investigate-preprocessor-'));
  await mkdir(join(cwd, 'packages', 'core', 'src'), { recursive: true });
  await mkdir(join(cwd, 'packages', 'server', 'src'), { recursive: true });
  await writeFile(join(cwd, 'packages', 'core', 'src', 'index.ts'), 'export function searchIndex() { return "candidate"; }\n');
  await writeFile(join(cwd, 'packages', 'server', 'src', 'server.ts'), 'export class Server { investigate() {} }\n');
  const payload: Record<string, unknown> = { prompt: 'where does investigate search the index?' };
  await investigatePreprocessor({ cwd, payload } as never);
  const candidates = payload.candidates as Array<{ path: string; name: string; startLine: number; endLine: number; snippet: string }>;
  const folders = payload.folderMap as Array<{ folder: string; fileCount: number; symbolCount: number }>;
  expect(candidates).toHaveLength(2);
  expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'packages/core/src/index.ts', name: 'searchIndex', startLine: 1, endLine: 1 })]));
  expect(folders).toEqual(expect.arrayContaining([expect.objectContaining({ folder: 'packages/core/src', fileCount: 1, symbolCount: 1 })]));
  expect(JSON.stringify({ candidates, folders }).split(/\s+/).length).toBeLessThanOrEqual(4000);
});