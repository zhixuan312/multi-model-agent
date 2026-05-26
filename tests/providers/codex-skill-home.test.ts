import { mkdtemp, mkdir, writeFile, lstat, readlink, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexSkillHome } from '../../packages/core/src/providers/codex-skill-home.js';

describe('prepareCodexSkillHome', () => {
  it('symlinks auth.json in OAuth mode and returns the staged root as CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mma-codex-'));
    await mkdir(join(root, 'skills', 'a'), { recursive: true });
    const realHome = await mkdtemp(join(tmpdir(), 'mma-realhome-'));
    await writeFile(join(realHome, 'auth.json'), '{"t":1}');
    const home = await prepareCodexSkillHome({ stagedRoot: root, authMode: 'oauth', realCodexHome: realHome });
    expect(home).toBe(root);
    const ln = await lstat(join(root, 'auth.json'));
    expect(ln.isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, 'auth.json'))).toBe(join(realHome, 'auth.json'));
    await rm(root, { recursive: true, force: true });
    await rm(realHome, { recursive: true, force: true });
  });

  it('does NOT symlink auth.json in env-key mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mma-codex-'));
    await mkdir(join(root, 'skills', 'a'), { recursive: true });
    await prepareCodexSkillHome({ stagedRoot: root, authMode: 'env-key', realCodexHome: homedir() });
    await expect(lstat(join(root, 'auth.json'))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
});
