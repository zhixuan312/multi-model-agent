// tests/identity/secret-redactor.test.ts
// Coverage for redactSecrets — applied to every diagnostic JSONL log record
// (log-writer.ts), i.e. the logs a user shares for debugging.
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../packages/core/src/identity/secret-redactor.js';

describe('redactSecrets', () => {
  it('redacts OpenAI-style sk- keys', () => {
    expect(redactSecrets('key sk-abcdef0123456789ABCDEF0123')).toBe('key [REDACTED-API-KEY]');
  });

  it('redacts Anthropic sk-ant- keys (sk- prefix)', () => {
    const out = redactSecrets('x sk-ant-api03-abcdefghijklmnop0123456789 y') as string;
    expect(out).toContain('[REDACTED-API-KEY]');
    expect(out).not.toContain('sk-ant');
  });

  it('redacts AWS access keys', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED-AWS-KEY]');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer vzygIAJqic9avYF8DjkG0re-riYFbxoW'))
      .toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts GitHub classic PATs (ghp_)', () => {
    const out = redactSecrets('git remote add o https://ghp_ABCDEFghijkl0123456789ABCDEFghijkl01@github.com/x/y') as string;
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]/);
    expect(out).toContain('[REDACTED');
  });

  it('redacts GitHub fine-grained PATs (github_pat_)', () => {
    const pat = 'github_pat_' + '1'.repeat(22) + '_' + 'a'.repeat(59);
    const out = redactSecrets(`token=${pat}`) as string;
    expect(out).not.toContain(pat);
    expect(out).toContain('[REDACTED');
  });

  it('redacts other GitHub token prefixes (gho_/ghu_/ghs_/ghr_)', () => {
    for (const prefix of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const tok = prefix + 'ABCDEFghijkl0123456789ABCDEFghijkl01';
      const out = redactSecrets(`x ${tok} y`) as string;
      expect(out, `${prefix} not redacted`).not.toContain(tok);
    }
  });

  it('redacts GitLab personal access tokens (glpat-)', () => {
    const tok = 'glpat-' + 'ABCDEFghijkl0123456789';
    const out = redactSecrets(`git remote add o https://oauth2:${tok}@gitlab.com/x/y`) as string;
    expect(out).not.toContain(tok);
    expect(out).toContain('[REDACTED');
  });

  it('redacts other GitLab token prefixes (gldt-/glrt-/glcbt-/glptt-)', () => {
    for (const prefix of ['gldt-', 'glrt-', 'glcbt-', 'glptt-']) {
      const tok = prefix + 'ABCDEFghijkl0123456789';
      const out = redactSecrets(`x ${tok} y`) as string;
      expect(out, `${prefix} not redacted`).not.toContain(tok);
    }
  });

  it('walks nested objects/arrays and leaves non-secrets intact', () => {
    const input = { a: ['plain', 'sk-abcdef0123456789ABCDEF0123'], b: { c: 'ghp_ABCDEFghijkl0123456789ABCDEFghijkl01' } };
    const out = redactSecrets(input) as { a: string[]; b: { c: string } };
    expect(out.a[0]).toBe('plain');
    expect(out.a[1]).toBe('[REDACTED-API-KEY]');
    expect(out.b.c).toContain('[REDACTED');
  });

  it('handles cyclic structures without throwing', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj.self = obj;
    expect(() => redactSecrets(obj)).not.toThrow();
    // …and marks the cycle where it closes, rather than anywhere the object appears.
    const out = redactSecrets(obj) as { name: string; self: unknown };
    expect(out.name).toBe('x');
    expect(out.self).toBe('[REDACTED-CYCLE]');
  });

  /**
   * A value referenced twice is not a cycle.
   *
   * `visited` used to be a "seen anywhere" set — entries were added and never removed — so the
   * SECOND appearance of any shared object became `[REDACTED-CYCLE]` even with no cycle present.
   * `buildEnvelopeSnapshot` does exactly this: `realFilesChanged: filesChangedFromGit ??
   * implTurn.filesWritten` makes both fields the same array on every read route, so every such
   * envelope reached the diagnostics JSONL with a redaction marker where its file list belonged.
   */
  it('keeps a value that appears twice, when neither appearance is a cycle', () => {
    const shared = ['src/a.ts', 'src/b.ts'];
    const input = { filesWritten: shared, realFilesChanged: shared };
    const out = redactSecrets(input) as { filesWritten: unknown; realFilesChanged: unknown };

    expect(out.filesWritten).toEqual(['src/a.ts', 'src/b.ts']);
    expect(out.realFilesChanged).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps a shared OBJECT that appears twice as siblings', () => {
    const shared = { model: 'claude-sonnet-4-6' };
    const out = redactSecrets({ implementer: shared, reviewer: shared }) as Record<string, unknown>;
    expect(out.implementer).toEqual({ model: 'claude-sonnet-4-6' });
    expect(out.reviewer).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('still redacts a secret inside a shared value, at both appearances', () => {
    const shared = { key: 'sk-abcdef0123456789ABCDEF0123' };
    const out = redactSecrets({ a: shared, b: shared }) as { a: { key: string }; b: { key: string } };
    expect(out.a.key).toBe('[REDACTED-API-KEY]');
    expect(out.b.key).toBe('[REDACTED-API-KEY]');
  });
});
