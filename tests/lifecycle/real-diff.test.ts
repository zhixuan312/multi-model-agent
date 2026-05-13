import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { getRealFilesChanged } from '../../packages/core/src/lifecycle/real-diff.js';

function makeRepo(): { cwd: string; sha: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-realdiff-'));
  execSync('git init && git config user.email t@t.com && git config user.name t', { cwd, shell: '/bin/bash' });
  writeFileSync(join(cwd, 'a.txt'), 'a');
  execSync('git add . && git commit -m init', { cwd, shell: '/bin/bash' });
  const sha = execSync('git rev-parse HEAD', { cwd }).toString().trim();
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
    writeFileSync(join(cwd, 'pre.txt'), 'pre');
    const state: any = {
      cwd,
      preTaskHeadSha: sha,
      preTaskUntrackedFiles: new Set([join(cwd, 'pre.txt')]),
    };
    writeFileSync(join(cwd, 'new.txt'), 'new');
    const r = await getRealFilesChanged(state);
    expect(r.source).toBe('git_diff');
    expect(r.files).toContain(join(cwd, 'new.txt'));
    expect(r.files).not.toContain(join(cwd, 'pre.txt'));
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

  it('returns git_error source when git invocation fails (bad sha)', async () => {
    const { cwd } = makeRepo();
    // Pass an invalid sha — git diff will fail with "bad object" status != 0
    const state: any = { cwd, preTaskHeadSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', preTaskUntrackedFiles: new Set() };
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
