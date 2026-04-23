import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadToken, validateAuthHeader } from '../../packages/server/src/http/auth.js';

describe('loadToken', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads token from file, trimming whitespace', () => {
    const f = path.join(tmp, 'token');
    fs.writeFileSync(f, '  abc123  \n');
    fs.chmodSync(f, 0o600);
    expect(loadToken(f)).toBe('abc123');
  });

  it('generates + writes a token if the file does not exist', () => {
    const f = path.join(tmp, 'new-token');
    const tok = loadToken(f);
    expect(tok).toMatch(/^[a-zA-Z0-9_-]{20,}$/);
    expect(fs.readFileSync(f, 'utf8').trim()).toBe(tok);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('expands ~ to homedir', () => {
    const filename = 'test-token-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const tildePath = `~/.multi-model/runtime/${filename}`;
    const resolvedPath = path.join(os.homedir(), '.multi-model/runtime', filename);
    try {
      const tok = loadToken(tildePath);
      expect(tok).toBeTruthy();
      expect(fs.existsSync(resolvedPath)).toBe(true);
    } finally {
      if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
    }
  });

  it('warns via stderr if existing token file has group/other read bits', () => {
    const f = path.join(tmp, 'loose-token');
    fs.writeFileSync(f, 'abc');
    fs.chmodSync(f, 0o644);
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      loadToken(f);
      expect(writes.some(w => /permissions|insecure|0600/i.test(w))).toBe(true);
    } finally {
      (process.stderr as NodeJS.WriteStream).write = origWrite;
    }
  });
});

describe('validateAuthHeader', () => {
  it('accepts Bearer <expected>', () => {
    expect(validateAuthHeader('Bearer abc', 'abc').ok).toBe(true);
  });
  it('rejects wrong token', () => {
    expect(validateAuthHeader('Bearer wrong', 'abc').ok).toBe(false);
  });
  it('rejects missing header', () => {
    expect(validateAuthHeader(undefined, 'abc').ok).toBe(false);
  });
  it('rejects malformed header', () => {
    expect(validateAuthHeader('abc', 'abc').ok).toBe(false);
    expect(validateAuthHeader('Basic abc', 'abc').ok).toBe(false);
  });
  it('is case-insensitive on scheme', () => {
    expect(validateAuthHeader('bearer abc', 'abc').ok).toBe(true);
  });
});
