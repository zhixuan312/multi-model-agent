import { describe, it, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { normalizeScopeEntry, isInScope } from '../../packages/core/src/bounded-execution/scope-match.js';

// Use an OS-native absolute root (normalizeScopeEntry uses node:path `resolve`,
// so on Windows it yields backslash drive paths). Build every expected path and
// every isInScope input via `join` against the same root so the comparison holds
// on POSIX, Windows, and Alpine alike — not just where '/abs/cwd' is literal.
const CWD = resolve('/abs/cwd');

describe('normalizeScopeEntry', () => {
  it('resolves relative paths against cwd', () => {
    const r = normalizeScopeEntry(CWD, 'src/foo.ts');
    expect(r.absPath).toBe(join(CWD, 'src/foo.ts'));
  });

  it('resolves .. traversal', () => {
    const r = normalizeScopeEntry(CWD, 'src/../lib/x.ts');
    expect(r.absPath).toBe(join(CWD, 'lib/x.ts'));
  });

  it('classifies trailing-slash as directory prefix', () => {
    const r = normalizeScopeEntry(CWD, 'src/auth/');
    expect(r.kind).toBe('directory');
  });

  it('classifies no-extension as directory prefix (inferred)', () => {
    const r = normalizeScopeEntry(CWD, 'src/auth');
    expect(r.kind).toBe('directory');
  });

  it('classifies with-extension as exact-file match', () => {
    const r = normalizeScopeEntry(CWD, 'src/foo.ts');
    expect(r.kind).toBe('file');
  });
});

describe('isInScope', () => {
  const scope = [
    normalizeScopeEntry(CWD, 'src/auth/'),
    normalizeScopeEntry(CWD, 'tests/auth.test.ts'),
  ];

  it('matches files under a directory prefix', () => {
    expect(isInScope(join(CWD, 'src/auth/jwt.ts'), scope)).toBe(true);
    expect(isInScope(join(CWD, 'src/auth/sub/deep.ts'), scope)).toBe(true);
  });

  it('exact-matches a file entry', () => {
    expect(isInScope(join(CWD, 'tests/auth.test.ts'), scope)).toBe(true);
  });

  it('rejects out-of-scope files', () => {
    expect(isInScope(join(CWD, 'tsconfig.json'), scope)).toBe(false);
    expect(isInScope(join(CWD, 'src/api.ts'), scope)).toBe(false);
  });

  it('rejects sibling that prefix-collides with a directory entry name', () => {
    // 'src/auth/' should NOT match 'src/authenticate.ts' (no leading-prefix collision)
    expect(isInScope(join(CWD, 'src/authenticate.ts'), scope)).toBe(false);
  });
});