import { canonicalizeFilePaths } from '../../packages/server/src/http/canonicalize-file-paths.js';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRepo(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'canon-')));
  mkdirSync(join(cwd, 'src/auth'), { recursive: true });
  writeFileSync(join(cwd, 'src/auth/refresh.ts'), '');
  return cwd;
}

describe('canonicalizeFilePaths', () => {
  it('accepts a path inside cwd and returns absolute canonical form', () => {
    const cwd = makeRepo();
    const r = canonicalizeFilePaths(['src/auth/refresh.ts'], cwd);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r).toEqual([join(cwd, 'src/auth/refresh.ts')]);
  });

  it('accepts a directory path (trailing slash okay)', () => {
    const cwd = makeRepo();
    const r = canonicalizeFilePaths(['src/auth/'], cwd);
    if ('error' in r) throw new Error('expected ok');
    expect(r).toEqual([join(cwd, 'src/auth')]);
  });

  it('rejects ../outside escape', () => {
    const cwd = makeRepo();
    const r = canonicalizeFilePaths(['../outside'], cwd);
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.fieldErrors.filePaths).toContain('../outside');
  });

  it('is path-boundary safe: cwd=/repo/app rejects /repo/app2/x.ts', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'canon-')));
    mkdirSync(join(root, 'app'));
    mkdirSync(join(root, 'app2'));
    writeFileSync(join(root, 'app2/x.ts'), '');
    const r = canonicalizeFilePaths([join(root, 'app2/x.ts')], join(root, 'app'));
    expect('error' in r).toBe(true);
  });

  it('rejects symlink that escapes cwd, even when target file does not exist', () => {
    const cwd = makeRepo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
    mkdirSync(join(cwd, 'src/link-parent'), { recursive: true });
    symlinkSync(outside, join(cwd, 'src/link-parent/link-to-outside'));
    const r = canonicalizeFilePaths(['src/link-parent/link-to-outside/missing.ts'], cwd);
    expect('error' in r).toBe(true);
  });

  it('deduplicates after canonicalization', () => {
    const cwd = makeRepo();
    const r = canonicalizeFilePaths(['./src/auth/', 'src/auth'], cwd);
    if ('error' in r) throw new Error('expected ok');
    expect(r).toEqual([join(cwd, 'src/auth')]);
  });

  it('accepts a nonexistent file whose enclosing dir is inside cwd', () => {
    const cwd = makeRepo();
    const r = canonicalizeFilePaths(['src/new-file.ts'], cwd);
    if ('error' in r) throw new Error('expected ok');
    expect(r).toEqual([join(cwd, 'src/new-file.ts')]);
  });

  it('treats a literal "*" as a filename character (no glob expansion)', () => {
    const cwd = makeRepo();
    const r = canonicalizeFilePaths(['src/*.ts'], cwd);
    if ('error' in r) throw new Error('expected ok');
    expect(r).toEqual([join(cwd, 'src/*.ts')]);
  });
});
