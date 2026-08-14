/**
 * tests/cli/info.test.ts — `mma info` subcommand.
 *
 * Uses injected fetch + temp dirs; never hits a real server.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInfo } from '../../packages/server/src/cli/info.js';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (s: string) => { stdout.push(s); return true; },
    stderrFn: (s: string) => { stderr.push(s); return true; },
  };
}

function mockFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
    } as Response)
  ) as typeof fetch;
}

function failingFetch(msg = 'ECONNREFUSED'): typeof fetch {
  return (() => Promise.reject(new Error(msg))) as typeof fetch;
}

function writeToken(contents = 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd\n'): { tokenFile: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mma-info-test-'));
  const tokenFile = join(dir, 'auth-token');
  writeFileSync(tokenFile, contents, { mode: 0o600 });
  return { tokenFile, dir };
}

describe('mma info (daemon not running)', () => {
  it('JSON output includes required fields with NotApplicable sentinels', async () => {
    const { tokenFile, dir } = writeToken();
    const cap = capture();
    try {
      const code = await runInfo({
        cliVersion: '3.1.0',
        bind: '127.0.0.1',
        port: 17337,
        tokenFile,
        json: true,
        stdout: cap.stdoutFn,
        stderr: cap.stderrFn,
        fetch: failingFetch(),
      });
      expect(code).toBe(0);
      const body = JSON.parse(cap.stdout.join(''));
      expect(body.cliVersion).toBe('3.1.0');
      expect(body.bind).toBe('127.0.0.1');
      expect(body.port).toBe(17337);
      expect(body.tokenFingerprint).toMatch(/^[a-f0-9]{8}$/);
      expect(body.running).toBe(false);
      expect(body.daemonVersion).toEqual({ kind: 'not_applicable', reason: 'daemon not running' });
      expect(body.pid).toEqual({ kind: 'not_applicable', reason: 'daemon not running' });
      expect(body.uptimeMs).toEqual({ kind: 'not_applicable', reason: 'daemon not running' });
      expect(body.startedAt).toEqual({ kind: 'not_applicable', reason: 'daemon not running' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('human output shows running=no and token fingerprint', async () => {
    const { tokenFile, dir } = writeToken();
    const cap = capture();
    try {
      const code = await runInfo({
        cliVersion: '3.1.0',
        bind: '127.0.0.1',
        port: 17337,
        tokenFile,
        stdout: cap.stdoutFn,
        stderr: cap.stderrFn,
        fetch: failingFetch(),
      });
      expect(code).toBe(0);
      const out = cap.stdout.join('');
      expect(out).toMatch(/running=no/);
      expect(out).toMatch(/token=[a-f0-9]{8}/);
      expect(out).toMatch(/cli=3\.1\.0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when token file missing', async () => {
    const cap = capture();
    const code = await runInfo({
      cliVersion: '3.1.0',
      bind: '127.0.0.1',
      port: 17337,
      tokenFile: '/tmp/mma-info-definitely-not-here',
      json: true,
      stdout: cap.stdoutFn,
      stderr: cap.stderrFn,
      fetch: failingFetch(),
    });
    expect(code).toBe(1);
    expect(cap.stderr.join('')).toMatch(/auth token file/);
  });
});

describe('mma info (daemon running)', () => {
  it('detects daemon running from /health status=ok', async () => {
    const { tokenFile, dir } = writeToken();
    const cap = capture();
    try {
      const code = await runInfo({
        cliVersion: '3.1.0',
        bind: '127.0.0.1',
        port: 17337,
        tokenFile,
        json: true,
        stdout: cap.stdoutFn,
        stderr: cap.stderrFn,
        fetch: mockFetch(200, { status: 'ok' }),
      });
      expect(code).toBe(0);
      const body = JSON.parse(cap.stdout.join(''));
      expect(body.running).toBe(true);
      expect(body.daemonVersion).toEqual({ kind: 'not_applicable', reason: 'daemon version predates info fields' });
      expect(body.pid).toEqual({ kind: 'not_applicable', reason: 'daemon version predates info fields' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // This slot held a byte-for-byte copy of the test above — same mock, same assertions, a
  // different name. So BOTH covered the omitted-fields branch and the populated one, which is what
  // every current daemon actually returns, was covered by nothing.
  it('surfaces the daemon fields when /health reports them', async () => {
    const { tokenFile, dir } = writeToken();
    const cap = capture();
    try {
      const code = await runInfo({
        cliVersion: '3.1.0',
        bind: '127.0.0.1',
        port: 17337,
        tokenFile,
        json: true,
        stdout: cap.stdoutFn,
        stderr: cap.stderrFn,
        fetch: mockFetch(200, {
          status: 'ok', version: '6.9.0', pid: 4242, uptimeMs: 90_000, startedAt: 1_700_000_000_000,
        }),
      });
      expect(code).toBe(0);
      const body = JSON.parse(cap.stdout.join(''));
      expect(body.running).toBe(true);
      expect(body.daemonVersion).toBe('6.9.0');
      expect(body.pid).toBe(4242);
      expect(body.uptimeMs).toBe(90_000);
      expect(body.startedAt).toBe(1_700_000_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a field of the wrong shape rather than passing it through', async () => {
    // `fromHealth` type-guards each field, so a daemon answering with a wrong-typed or empty value
    // must degrade to the sentinel — not surface a `pid` of `"unknown"` that a caller then formats
    // into a kill command.
    const { tokenFile, dir } = writeToken();
    const cap = capture();
    try {
      await runInfo({
        cliVersion: '3.1.0',
        bind: '127.0.0.1',
        port: 17337,
        tokenFile,
        json: true,
        stdout: cap.stdoutFn,
        stderr: cap.stderrFn,
        fetch: mockFetch(200, { status: 'ok', version: '', pid: 'not-a-number' }),
      });
      const body = JSON.parse(cap.stdout.join(''));
      expect(body.daemonVersion).toEqual({ kind: 'not_applicable', reason: 'daemon version predates info fields' });
      expect(body.pid).toEqual({ kind: 'not_applicable', reason: 'daemon version predates info fields' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
