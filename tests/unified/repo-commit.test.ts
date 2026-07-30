import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isGitRepo,
  captureBaseline,
  commitAll,
  assertRepoUntampered,
  filesChangedSince,
} from '../../packages/core/src/unified/repo-commit.js';

/**
 * The engine-owned git layer that replaced WorktreeManager. These run against REAL temp repos —
 * the behaviour being asserted is git's, so mocking it would test nothing.
 */

let repo: string;
/** The repo's initial branch — depends on the machine's `init.defaultBranch`, so never assume. */
let baseBranch: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mma-repo-commit-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'seed.txt'), 'seed\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(['checkout', '-q', '-b', 'mma/2026-07-31-demo']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('isGitRepo', () => {
  it('detects a repo root', async () => {
    expect(await isGitRepo(repo)).toBe(true);
  });

  it('is false for a plain directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'mma-plain-'));
    try { expect(await isGitRepo(plain)).toBe(false); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  });
});

describe('captureBaseline', () => {
  it('records HEAD, the caller branch, and a clean tree', async () => {
    const b = await captureBaseline(repo);
    expect(b.head).toMatch(/^[0-9a-f]{40}$/);
    expect(b.branch).toBe('mma/2026-07-31-demo');
    expect(b.dirtyAtDispatch).toBe(false);
  });

  it('reports dirtyAtDispatch for a modified tracked file, a staged change, and an untracked file', async () => {
    writeFileSync(join(repo, 'seed.txt'), 'changed\n');
    expect((await captureBaseline(repo)).dirtyAtDispatch).toBe(true);

    git(['checkout', '--', 'seed.txt']);
    writeFileSync(join(repo, 'brand-new.txt'), 'x\n');
    expect((await captureBaseline(repo)).dirtyAtDispatch).toBe(true);
  });

  it('returns a null baseline for a non-git target rather than throwing', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'mma-plain-'));
    try {
      const b = await captureBaseline(plain);
      expect(b).toEqual({ head: null, branch: null, dirtyAtDispatch: false, statusText: '' });
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
});

describe('commitAll', () => {
  it('commits worker edits on the caller branch and reports git-derived filesChanged', async () => {
    const baseline = await captureBaseline(repo);
    writeFileSync(join(repo, 'worker.ts'), 'export const x = 1;\n');

    const out = await commitAll(repo, baseline, '[mma] delegate: add worker.ts');

    expect(out.committed).toBe(true);
    expect(out.filesChanged).toEqual(['worker.ts']);
    // Still on the caller's branch, and no new branch was created.
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('mma/2026-07-31-demo');
    expect(git(['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort())
      .toEqual([baseBranch, 'mma/2026-07-31-demo'].sort());
  });

  it('sweeps a pre-existing dirty change in alongside the worker edit (FR-2, deliberate)', async () => {
    writeFileSync(join(repo, 'preexisting.txt'), 'wip\n');
    const baseline = await captureBaseline(repo);
    expect(baseline.dirtyAtDispatch).toBe(true);

    writeFileSync(join(repo, 'worker.ts'), 'export const x = 1;\n');
    const out = await commitAll(repo, baseline, '[mma] delegate: work');

    expect(out.committed).toBe(true);
    expect(out.filesChanged.sort()).toEqual(['preexisting.txt', 'worker.ts']);
  });

  /**
   * The guard that exists because this actually happened: a contract test dispatched a no-op
   * `delegate` against the engine checkout, and `git add -A` committed the developer's
   * uncommitted work. A task that changed nothing must leave the caller's tree alone.
   */
  it('does NOT commit when the worker changed nothing, even if the tree was already dirty', async () => {
    writeFileSync(join(repo, 'my-wip.txt'), 'developer work in progress\n');
    const baseline = await captureBaseline(repo);
    const headBefore = git(['rev-parse', 'HEAD']).trim();

    const out = await commitAll(repo, baseline, '[mma] delegate: do something');

    expect(out.committed).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    // The developer's work is still uncommitted, exactly where they left it.
    expect(git(['status', '--porcelain'])).toContain('my-wip.txt');
  });

  it('is a no-op on a clean tree with no worker edits', async () => {
    const baseline = await captureBaseline(repo);
    const out = await commitAll(repo, baseline, '[mma] delegate: nothing');
    expect(out.committed).toBe(false);
    expect(out.filesChanged).toEqual([]);
  });

  it('does nothing for a non-git target', async () => {
    const out = await commitAll('/nonexistent', { head: null, branch: null, dirtyAtDispatch: false, statusText: '' }, 'm');
    expect(out).toEqual({ committed: false, head: null, filesChanged: [] });
  });
});

describe('assertRepoUntampered', () => {
  it('passes when the worker left git alone', async () => {
    const baseline = await captureBaseline(repo);
    writeFileSync(join(repo, 'worker.ts'), 'x\n');
    await expect(assertRepoUntampered(repo, baseline)).resolves.toBeUndefined();
  });

  it('throws when the worker switched branch', async () => {
    const baseline = await captureBaseline(repo);
    git(['checkout', '-q', baseBranch]);
    await expect(assertRepoUntampered(repo, baseline)).rejects.toThrow(/changed the checked-out branch/);
  });

  it('throws when the worker moved HEAD (self-commit / reset)', async () => {
    const baseline = await captureBaseline(repo);
    writeFileSync(join(repo, 'sneaky.txt'), 'x\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'worker self-commit']);
    await expect(assertRepoUntampered(repo, baseline)).rejects.toThrow(/moved HEAD/);
  });

  it('is a no-op for a non-git target', async () => {
    await expect(
      assertRepoUntampered('/nonexistent', { head: null, branch: null, dirtyAtDispatch: false, statusText: '' }),
    ).resolves.toBeUndefined();
  });
});

describe('filesChangedSince', () => {
  it('lists files between two commits', async () => {
    const from = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repo, 'a.ts'), 'a\n');
    writeFileSync(join(repo, 'b.ts'), 'b\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'two files']);
    expect((await filesChangedSince(repo, from)).sort()).toEqual(['a.ts', 'b.ts']);
  });
});
