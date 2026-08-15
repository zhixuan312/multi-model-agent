import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadToken, validateAuthHeader } from '../../packages/server/src/http/auth.js';
import { startTestServer } from '../helpers/test-server.js';

describe('loadToken', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads canonical token file (token + LF, no extra whitespace)', () => {
    const f = path.join(tmp, 'token');
    fs.writeFileSync(f, 'abc123\n');
    fs.chmodSync(f, 0o600);
    expect(loadToken(f)).toBe('abc123');
  });

  it('rejects token file with surrounding whitespace (strict validation)', () => {
    const f = path.join(tmp, 'token-loose');
    fs.writeFileSync(f, '  abc123  \n');
    fs.chmodSync(f, 0o600);
    expect(() => loadToken(f)).toThrow(/non-canonical/);
  });

  it('generates + writes a token if the file does not exist', () => {
    const f = path.join(tmp, 'new-token');
    const tok = loadToken(f);
    expect(tok).toMatch(/^[a-zA-Z0-9_-]{20,}$/);
    expect(fs.readFileSync(f, 'utf8').trim()).toBe(tok);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  /**
   * `~` expansion, without writing into the developer's real home.
   *
   * This used to mint a token at `~/.mma/runtime/test-token-<ts>` in the ACTUAL home directory
   * and delete it in a `finally`. An assertion that threw before the finally, or a killed run,
   * left files in the user's real `~/.mma` — and `~/.mma/runtime` is a live daemon path, not a
   * scratch area. Redirecting HOME/USERPROFILE keeps the same coverage (that `loadToken` routes
   * through `expandHome` at all) with nothing outside the temp dir.
   */
  it('expands ~ to homedir', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-home-'));
    const prevHome = process.env['HOME'];
    const prevProfile = process.env['USERPROFILE'];
    process.env['HOME'] = fakeHome;
    process.env['USERPROFILE'] = fakeHome;
    try {
      const tok = loadToken('~/.mma/runtime/test-token');
      expect(tok).toBeTruthy();
      expect(fs.existsSync(path.join(fakeHome, '.mma/runtime/test-token'))).toBe(true);
      // ...and nowhere else: the point of the expansion is WHICH directory it lands in.
      expect(loadToken('~/.mma/runtime/test-token')).toBe(tok);
    } finally {
      if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
      if (prevProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = prevProfile;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('warns via stderr if existing token file has group/other read bits', () => {
    const f = path.join(tmp, 'loose-token');
    fs.writeFileSync(f, 'abc\n');
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

  it('MMA_AUTH_TOKEN env override wins over file contents', () => {
    const f = path.join(tmp, 'token-env');
    fs.writeFileSync(f, 'file-token\n', { mode: 0o600 });
    const prev = process.env['MMA_AUTH_TOKEN'];
    process.env['MMA_AUTH_TOKEN'] = 'env-override-token';
    try {
      const tok = loadToken(f);
      expect(tok).toBe('env-override-token');
    } finally {
      if (prev === undefined) {
        delete process.env['MMA_AUTH_TOKEN'];
      } else {
        process.env['MMA_AUTH_TOKEN'] = prev;
      }
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
  it('uses timingSafeEqual (tokens of different length → mismatch, not throw)', () => {
    expect(validateAuthHeader('Bearer short', 'a-much-longer-expected-token').ok).toBe(false);
  });

  /**
   * Every case above asserted only `.ok`, so the three-way `reason` — the one thing this function
   * reports beyond pass/fail — had no coverage and no reader anywhere in the server either. It is
   * now written to the daemon's stderr on a 401, where `missing` (client never configured),
   * `malformed` (not a `Bearer <token>` header) and `mismatch` (stale or wrong token, e.g. an
   * `MMA_AUTH_TOKEN` env override disagreeing with the token file) are three different operator
   * problems that used to look identical in the log.
   */
  it('names which check failed, distinctly', () => {
    expect(validateAuthHeader(undefined, 'abc')).toEqual({ ok: false, reason: 'missing' });
    expect(validateAuthHeader('', 'abc')).toEqual({ ok: false, reason: 'missing' });
    expect(validateAuthHeader('abc', 'abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateAuthHeader('Basic abc', 'abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateAuthHeader('Bearer a b', 'abc')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateAuthHeader('Bearer wrong', 'abc')).toEqual({ ok: false, reason: 'mismatch' });
    expect(validateAuthHeader('Bearer short', 'a-much-longer-token')).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('401 responses stay generic while the daemon log does not', () => {
  it('answers every rejection identically and records the reason on stderr', async () => {
    const s = await startTestServer();
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const cases: [string, Record<string, string>][] = [
        ['missing', {}],
        ['malformed', { Authorization: 'Basic zzz' }],
        ['mismatch', { Authorization: 'Bearer definitely-not-the-token' }],
      ];
      for (const [reason, headers] of cases) {
        const res = await fetch(`${s.url}/status`, { headers });
        expect(res.status, reason).toBe(401);
        // The body must not distinguish the three — a client learns only that it failed.
        expect(await res.json(), reason).toEqual({
          error: { code: 'unauthorized', message: 'Valid Bearer token required' },
        });
        expect(written.join(''), `stderr should name ${reason}`).toContain(`reason=${reason}`);
      }
    } finally {
      spy.mockRestore();
      await s.stop();
    }
  });
});
