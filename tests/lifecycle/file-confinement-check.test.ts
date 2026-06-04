import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { findEscapedWrites } from '../../packages/core/src/lifecycle/file-confinement-check.js';

describe('findEscapedWrites', () => {
  it('returns [] for an empty write list', () => {
    expect(findEscapedWrites([], '/some/cwd')).toEqual([]);
  });

  it('treats relative paths as inside cwd', () => {
    expect(findEscapedWrites(['src/a.ts', 'b.ts'], '/repo')).toEqual([]);
  });

  it('treats absolute paths under cwd as inside', () => {
    expect(findEscapedWrites(['/repo/src/a.ts'], '/repo')).toEqual([]);
  });

  it('flags an absolute path outside cwd', () => {
    expect(findEscapedWrites(['/other/x.ts'], '/repo')).toEqual(['/other/x.ts']);
  });

  it('flags a sibling-directory escape (the worktree bug shape)', () => {
    expect(
      findEscapedWrites(['/proj/main-worktree/feature.py'], '/proj/phase1-worktree'),
    ).toEqual(['/proj/main-worktree/feature.py']);
  });

  it('does not flag cwd itself', () => {
    expect(findEscapedWrites(['/repo'], '/repo')).toEqual([]);
  });

  it('catches a symlink inside cwd that points outside cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mma-confine-cwd-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'mma-confine-out-'));
    const outsideFile = join(outsideDir, 'real.txt');
    await writeFile(outsideFile, 'x');
    const linkInside = join(cwd, 'looks-local.txt');
    await symlink(outsideFile, linkInside);
    // Lexically the path is inside cwd, but realpath resolves outside -> flagged.
    expect(findEscapedWrites([linkInside], cwd)).toEqual([linkInside]);
  });

  it('does not flag a real file that exists inside cwd', async () => {
    const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'mma-confine-ok-')));
    const inside = join(cwd, 'note.txt');
    await writeFile(inside, 'x');
    expect(findEscapedWrites([inside], cwd)).toEqual([]);
  });
});
