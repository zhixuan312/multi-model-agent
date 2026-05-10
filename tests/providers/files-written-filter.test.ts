import { describe, it, expect } from 'vitest';
import { filterValidWritePath } from '../../packages/core/src/providers/file-tracker.js';

/**
 * A4b §2a path-validity filter — five rules:
 *   1. Reject `shell:`-prefixed entries.
 *   2. Reject entries containing shell control characters: < > | & ; ` $ ( )
 *   3. Reject entries that don't match ^[A-Za-z0-9_.][^\s'"]*$
 *      (must start with alphanumeric/_/.; no whitespace/quotes).
 *   4. Reject entries longer than 4096 chars.
 *   5. Reject absolute paths (starting with `/`).
 */
describe('A4b.1 filterValidWritePath', () => {
  it('rejects shell:-prefixed entries (rule 1)', () => {
    expect(filterValidWritePath('shell:cat > "src/foo.ts" << EOF')).toBe(false);
    expect(filterValidWritePath('shell:python -c "..."')).toBe(false);
    expect(filterValidWritePath('shell:echo hi')).toBe(false);
  });

  it('rejects entries with shell control characters (rule 2)', () => {
    for (const s of [
      'src/foo.ts && rm -rf /',
      'cat > src/foo.ts',
      'src/foo.ts | tee log',
      'src/foo.ts; echo done',
      'echo $HOME > src/foo.ts',
      'src/`whoami`.ts',
      'src/$(whoami).ts',
      'src/(parens).ts',
    ]) {
      expect(filterValidWritePath(s), `should reject: ${s}`).toBe(false);
    }
  });

  it('rejects paths with whitespace or quotes (rule 3)', () => {
    expect(filterValidWritePath('src/foo bar.ts')).toBe(false);
    expect(filterValidWritePath('src/foo"bar".ts')).toBe(false);
    expect(filterValidWritePath("src/foo'bar'.ts")).toBe(false);
    expect(filterValidWritePath('src/\tfoo.ts')).toBe(false);
    expect(filterValidWritePath('src/\nfoo.ts')).toBe(false);
  });

  it('rejects entries that do not start with alphanumeric/_/. (rule 3)', () => {
    expect(filterValidWritePath('-foo.ts')).toBe(false);
    expect(filterValidWritePath('+foo.ts')).toBe(false);
    expect(filterValidWritePath('@foo.ts')).toBe(false);
  });

  it('rejects entries longer than 4096 chars (rule 4)', () => {
    expect(filterValidWritePath('a'.repeat(4097))).toBe(false);
    expect(filterValidWritePath('a'.repeat(4096))).toBe(true); // exactly at limit OK
  });

  it('rejects absolute paths (rule 5 — sandbox-escape guard)', () => {
    expect(filterValidWritePath('/etc/passwd')).toBe(false);
    expect(filterValidWritePath('/Users/zhang/.ssh/id_rsa')).toBe(false);
    expect(filterValidWritePath('/tmp/foo.ts')).toBe(false);
  });

  it('rejects empty / non-string entries', () => {
    expect(filterValidWritePath('')).toBe(false);
    expect(filterValidWritePath(undefined as unknown as string)).toBe(false);
    expect(filterValidWritePath(null as unknown as string)).toBe(false);
    expect(filterValidWritePath(42 as unknown as string)).toBe(false);
  });

  it('accepts valid relative paths', () => {
    for (const s of [
      'src/foo.ts',
      'tests/foo.test.ts',
      'docs/README.md',
      '_private/x.ts',
      '.dotfile',
      'a.b.c.d',
      'packages/core/src/config/schema.ts',
      'tests/config/context-block-cap-defaults.test.ts',
      '0123.ts',
    ]) {
      expect(filterValidWritePath(s), `should accept: ${s}`).toBe(true);
    }
  });
});
