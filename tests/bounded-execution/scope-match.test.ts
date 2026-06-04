import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { normalizeScopeEntry, isInScope } from '../../packages/core/src/bounded-execution/scope-match.js';

describe('normalizeScopeEntry', () => {
  it('resolves relative paths against cwd', () => {
    const r = normalizeScopeEntry('/abs/cwd', 'src/foo.ts');
    expect(r.absPath).toBe('/abs/cwd/src/foo.ts');
  });

  it('resolves .. traversal', () => {
    const r = normalizeScopeEntry('/abs/cwd', 'src/../lib/x.ts');
    expect(r.absPath).toBe('/abs/cwd/lib/x.ts');
  });

  it('classifies trailing-slash as directory prefix', () => {
    const r = normalizeScopeEntry('/abs/cwd', 'src/auth/');
    expect(r.kind).toBe('directory');
  });

  it('classifies no-extension as directory prefix (inferred)', () => {
    const r = normalizeScopeEntry('/abs/cwd', 'src/auth');
    expect(r.kind).toBe('directory');
  });

  it('classifies with-extension as exact-file match', () => {
    const r = normalizeScopeEntry('/abs/cwd', 'src/foo.ts');
    expect(r.kind).toBe('file');
  });
});

describe('isInScope', () => {
  const cwd = '/abs/cwd';
  const scope = [
    normalizeScopeEntry(cwd, 'src/auth/'),
    normalizeScopeEntry(cwd, 'tests/auth.test.ts'),
  ];

  it('matches files under a directory prefix', () => {
    expect(isInScope('/abs/cwd/src/auth/jwt.ts', scope)).toBe(true);
    expect(isInScope('/abs/cwd/src/auth/sub/deep.ts', scope)).toBe(true);
  });

  it('exact-matches a file entry', () => {
    expect(isInScope('/abs/cwd/tests/auth.test.ts', scope)).toBe(true);
  });

  it('rejects out-of-scope files', () => {
    expect(isInScope('/abs/cwd/tsconfig.json', scope)).toBe(false);
    expect(isInScope('/abs/cwd/src/api.ts', scope)).toBe(false);
  });

  it('rejects sibling that prefix-collides with a directory entry name', () => {
    // 'src/auth/' should NOT match 'src/authenticate.ts' (no leading-prefix collision)
    expect(isInScope('/abs/cwd/src/authenticate.ts', scope)).toBe(false);
  });
});