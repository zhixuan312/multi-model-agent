import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAuthToken } from '@zhixuan92/multi-model-agent-core';

function mkTokenFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tok-'));
  const p = join(dir, 'auth-token');
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

describe('loadAuthToken strict validation', () => {
  it('accepts canonical (token + LF)', () => {
    const p = mkTokenFile('aaaaaaaabbbbbbbb\n');
    expect(loadAuthToken({ tokenFile: p })).toBe('aaaaaaaabbbbbbbb');
  });

  it('rejects CRLF', () => {
    const p = mkTokenFile('aaaaaaaabbbbbbbb\r\n');
    expect(() => loadAuthToken({ tokenFile: p })).toThrow(/CRLF/);
  });

  it('rejects missing trailing LF', () => {
    const p = mkTokenFile('aaaaaaaabbbbbbbb');
    expect(() => loadAuthToken({ tokenFile: p })).toThrow(/LF/);
  });

  it('rejects extra trailing whitespace before LF', () => {
    const p = mkTokenFile('aaaaaaaabbbbbbbb  \n');
    expect(() => loadAuthToken({ tokenFile: p })).toThrow(/non-canonical/);
  });

  it('rejects leading whitespace', () => {
    const p = mkTokenFile('  aaaaaaaabbbbbbbb\n');
    expect(() => loadAuthToken({ tokenFile: p })).toThrow(/non-canonical/);
  });

  it('rejects characters outside the regex', () => {
    const p = mkTokenFile('abc!!!def\n');
    expect(() => loadAuthToken({ tokenFile: p })).toThrow(/non-canonical/);
  });

  it('env var override bypasses file validation', () => {
    process.env['MMAGENT_AUTH_TOKEN'] = 'override-token-value';
    try {
      expect(loadAuthToken({ tokenFile: '/nonexistent' })).toBe('override-token-value');
    } finally {
      delete process.env['MMAGENT_AUTH_TOKEN'];
    }
  });

  it('accepts canonical token with all allowed special chars', () => {
    const p = mkTokenFile('abc-def_ghi+jkl=mno/pqr.stu\n');
    expect(loadAuthToken({ tokenFile: p })).toBe('abc-def_ghi+jkl=mno/pqr.stu');
  });
});
