import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskSpec } from '../../packages/core/src/types/task-spec.js';
import { groupTasksByRepo } from '../../packages/core/src/lifecycle/task-grouping.js';
import * as gitTop from '../../packages/core/src/lifecycle/git-toplevel.js';
import { withTempGitRepo } from './with-temp-git-repo.js';

function task(cwd: string, prompt = 'p'): TaskSpec {
  return { prompt, cwd };
}

describe('groupTasksByRepo', () => {
  it('groups three tasks in same cwd into one group', async () => {
    await withTempGitRepo(async (repo) => {
      const tasks = [task(repo), task(repo), task(repo)];
      const groups = await groupTasksByRepo(tasks);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.tasks.map((t) => t.originalIndex)).toEqual([0, 1, 2]);
    });
  });

  it('groups three subdirs of one repo into one group', async () => {
    await withTempGitRepo(async (repo) => {
      const sub1 = join(repo, 'a');
      const sub2 = join(repo, 'b');
      const sub3 = join(repo, 'c');
      await fs.mkdir(sub1); await fs.mkdir(sub2); await fs.mkdir(sub3);
      const groups = await groupTasksByRepo([task(sub1), task(sub2), task(sub3)]);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.key).toBe(repo);
    });
  });

  it('groups two repos into two groups in input-order', async () => {
    await withTempGitRepo(async (repoA) => {
      await withTempGitRepo(async (repoB) => {
        const groups = await groupTasksByRepo([
          task(repoA), task(repoB), task(repoA), task(repoB),
        ]);
        expect(groups).toHaveLength(2);
        // Group A first (contains tasks[0])
        expect(groups[0]!.key).toBe(repoA);
        expect(groups[0]!.tasks.map((t) => t.originalIndex)).toEqual([0, 2]);
        expect(groups[1]!.key).toBe(repoB);
        expect(groups[1]!.tasks.map((t) => t.originalIndex)).toEqual([1, 3]);
      });
    });
  });

  it('falls back to realpath(cwd) when not a git repo', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'mma-no-git-'));
    try {
      const real = await fs.realpath(dir);
      const groups = await groupTasksByRepo([task(real), task(real)]);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.key).toBe(real);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('memoizes resolveGitToplevel per unique cwd', async () => {
    await withTempGitRepo(async (repo) => {
      const spy = vi.spyOn(gitTop, 'resolveGitToplevel');
      try {
        const tasks = [task(repo), task(repo), task(repo), task(repo)];
        await groupTasksByRepo(tasks);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('uses raw cwd verbatim when realpath fails', async () => {
    const phantom = '/nonexistent/phantom-cwd-mma';
    const groups = await groupTasksByRepo([task(phantom), task(phantom)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe(phantom);
  });
});
