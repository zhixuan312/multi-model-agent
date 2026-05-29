import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRealFilesChanged } from '../../packages/core/src/bounded-execution/real-diff.js';
import { git, initGitRepo, commit, removeGitDir } from '../helpers/git-repo.js';

function makeRepo(): { cwd: string; sha: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-realdiff-'));
  initGitRepo(cwd);
  writeFileSync(join(cwd, 'a.txt'), 'a');
  commit(cwd, 'init');
  const sha = git(cwd, 'rev-parse', 'HEAD');
  return { cwd, sha };
}

describe('getRealFilesChanged', () => {
  it('returns tracked-modified files', async () => {
    const { cwd, sha } = makeRepo();
    writeFileSync(join(cwd, 'a.txt'), 'modified');
    const state: any = { cwd, preTaskHeadSha: sha, preTaskUntrackedFiles: new Set() };
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('git_diff');
    expect(r.files).toEqual([join(cwd, 'a.txt')]);
  });

  it('returns NEW untracked files but not pre-existing untracked files', async () => {
    const { cwd, sha } = makeRepo();
    // pre-existing untracked file in the snapshot:
    writeFileSync(join(cwd, 'pre.txt'), 'pre');
    const state: any = {
      cwd,
      preTaskHeadSha: sha,
      preTaskUntrackedFiles: new Set([join(cwd, 'pre.txt')]),
    };
    // worker creates a NEW untracked file during the task:
    writeFileSync(join(cwd, 'new.txt'), 'new');
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('git_diff');
    expect(r.files).toContain(join(cwd, 'new.txt'));
    expect(r.files).not.toContain(join(cwd, 'pre.txt'));
  });

  it('resolves cwd from executionContext when state.cwd is unset (production wiring)', async () => {
    // Production puts the cwd on state.executionContext.cwd, NOT state.cwd.
    // Without the fallback, getRealFilesChanged goes inert and falls back to
    // the (possibly empty) worker self_report.
    const { cwd, sha } = makeRepo();
    writeFileSync(join(cwd, 'new.txt'), 'new');
    const state: any = {
      executionContext: { cwd },
      preTaskHeadSha: sha,
      preTaskUntrackedFiles: new Set(),
      lastRunResult: { filesChanged: [] }, // worker under-reported → self_report would be empty
    };
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('git_diff');
    expect(r.files).toContain(join(cwd, 'new.txt'));
  });

  it('falls back to self_report for non-git cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mma-realdiff-nongit-'));
    const state: any = {
      cwd,
      preTaskHeadSha: undefined,
      preTaskUntrackedFiles: undefined,
      lastRunResult: { filesChanged: ['/some/path.ts'] },
    };
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('self_report');
    expect(r.files).toEqual(['/some/path.ts']);
  });

  it('returns git_error source when git invocation fails', async () => {
    // Corrupt the .git directory after capturing sha:
    const { cwd, sha } = makeRepo();
    removeGitDir(cwd);
    const state: any = { cwd, preTaskHeadSha: sha, preTaskUntrackedFiles: new Set() };
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('git_error');
    expect(r.files).toEqual([]);
  });

  it('returns empty file list when nothing changed', async () => {
    const { cwd, sha } = makeRepo();
    const state: any = { cwd, preTaskHeadSha: sha, preTaskUntrackedFiles: new Set() };
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('git_diff');
    expect(r.files).toEqual([]);
  });
});