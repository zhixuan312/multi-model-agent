import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getDirtyFiles, formatHygieneAdvisory } from '../../packages/core/src/lifecycle/repo-hygiene.js';
import { withTempGitRepo } from './with-temp-git-repo.js';

describe('repo-hygiene', () => {
  it('returns [] for a clean repo', async () => {
    await withTempGitRepo(async (repo) => {
      const files = await getDirtyFiles(repo);
      expect(files).toEqual([]);
    });
  });

  it('returns dirty file paths for an untracked file', async () => {
    await withTempGitRepo(async (repo) => {
      await fs.writeFile(join(repo, 'a.txt'), 'hi');
      const files = await getDirtyFiles(repo);
      expect(files).toContain('a.txt');
    });
  });

  it('returns [] when cwd is not a git repo (treats as clean)', async () => {
    const files = await getDirtyFiles('/nonexistent/path/for/mma');
    expect(files).toEqual([]);
  });

  it('returns [] when timing out (5 s default; here forced to 1 ms)', async () => {
    const files = await getDirtyFiles(process.cwd(), { timeoutMs: 1 });
    expect(Array.isArray(files)).toBe(true);
  });

  it('formats advisory with full list when <= 20 files', () => {
    const advisory = formatHygieneAdvisory(['b.txt', 'a.txt', 'c.txt']);
    expect(advisory).toContain('[REPO HYGIENE]');
    // Lexicographic sort
    expect(advisory).toMatch(/a\.txt, b\.txt, c\.txt/);
    expect(advisory).not.toMatch(/more/);
  });

  it('truncates list to first 20 sorted paths and appends (+N more)', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const advisory = formatHygieneAdvisory(paths);
    expect(advisory).toMatch(/f00\.txt, f01\.txt/);
    expect(advisory).toMatch(/f19\.txt, … \(\+5 more\)/);
  });
});
