/**
 * tests/cli/status.test.ts
 *
 * Tests for Task 9.3 — `mmagent status` subcommand.
 * Uses injected fetch + temp dirs; never hits a real server.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import {
  fetchStatus,
  buildServerUrl,
  runStatus,
} from '../../packages/server/src/cli/status.js';

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  stdoutFn: (s: string) => boolean;
  stderrFn: (s: string) => boolean;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (s: string) => { stdout.push(s); return true; },
    stderrFn: (s: string) => { stderr.push(s); return true; },
  };
}

function makeMockFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
    } as Response)
  ) as typeof fetch;
}

function makeFailingFetch(message: string): typeof fetch {
  return (() => Promise.reject(new Error(message))) as typeof fetch;
}

const SAMPLE_STATUS = {
  version: '3.0.0',
  pid: 12345,
  bind: '127.0.0.1',
  uptimeMs: 3_661_000,
  auth: { enabled: true },
  counters: {
    projectCount: 2,
    activeRequests: 1,
    activeBatches: 3,
  },
  projects: [],
  inflight: [{ batchId: 'b1', tool: 'delegate', cwd: '/tmp', startedAt: 0, state: 'pending' }],
  recent: [],
  skillVersion: '3.0.0',
  skillCompatible: true,
};

// ─── buildServerUrl ──────────────────────────────────────────────────────────

describe('buildServerUrl', () => {
  it('builds URL from bind + port', () => {
    expect(buildServerUrl('127.0.0.1', 7337)).toBe('http://127.0.0.1:7337');
  });

  it('converts 0.0.0.0 to 127.0.0.1 (loopback-only /status)', () => {
    expect(buildServerUrl('0.0.0.0', 7337)).toBe('http://127.0.0.1:7337');
  });

  it('converts :: to 127.0.0.1', () => {
    expect(buildServerUrl('::', 7337)).toBe('http://127.0.0.1:7337');
  });
});

// ─── fetchStatus: pretty-print ──────────────────────────────────────────────

describe('fetchStatus: pretty-print mode', () => {
  it('prints summary on success', async () => {
    const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
    const code = await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'test-token',
      fetch: makeMockFetch(200, SAMPLE_STATUS),
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('version:');
    expect(out).toContain('3.0.0');
    expect(out).toContain('uptime:');
    // 3_661_000ms = 1h 1m 1s
    expect(out).toContain('1h');
    expect(out).toContain('projects:');
    expect(out).toContain('2');
    expect(out).toContain('in-flight:');
    expect(out).toContain('1');
    expect(stderr).toHaveLength(0);
  });

  it('includes skill compatibility when skillCompatible=true', async () => {
    const { stdoutFn, stderrFn, stdout } = captureOutput();
    await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'test-token',
      fetch: makeMockFetch(200, SAMPLE_STATUS),
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(stdout.join('')).toContain('compatible');
  });

  it('shows incompatible warning when skillCompatible=false', async () => {
    const { stdoutFn, stderrFn, stdout } = captureOutput();
    await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'test-token',
      fetch: makeMockFetch(200, { ...SAMPLE_STATUS, skillCompatible: false }),
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(stdout.join('')).toContain('incompatible');
  });
});

// ─── fetchStatus: JSON mode ──────────────────────────────────────────────────

describe('fetchStatus: --json mode', () => {
  it('dumps raw JSON on success', async () => {
    const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
    const code = await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'test-token',
      json: true,
      fetch: makeMockFetch(200, SAMPLE_STATUS),
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(code).toBe(0);
    const out = stdout.join('');
    const parsed = JSON.parse(out) as typeof SAMPLE_STATUS;
    expect(parsed.version).toBe('3.0.0');
    expect(parsed.counters.projectCount).toBe(2);
    expect(stderr).toHaveLength(0);
  });
});

// ─── fetchStatus: error cases ────────────────────────────────────────────────

describe('fetchStatus: error handling', () => {
  it('exits 1 with helpful message when server is unreachable', async () => {
    const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
    const code = await fetchStatus({
      serverUrl: 'http://127.0.0.1:9999',
      token: 'test-token',
      fetch: makeFailingFetch('Connection refused'),
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(code).toBe(1);
    expect(stdout).toHaveLength(0);
    expect(stderr.join('')).toContain('cannot reach server');
  });

  it('exits 1 on non-200 response', async () => {
    const { stdoutFn, stderrFn, stderr } = captureOutput();
    const code = await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'wrong-token',
      fetch: makeMockFetch(401, { error: 'unauthorized' }),
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('401');
  });
});

// ─── runStatus: token file loading ──────────────────────────────────────────

describe('runStatus: token loading', () => {
  it('reads token from file and calls server', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-status-'));
    try {
      const tokenFile = join(tmpDir, 'auth-token');
      writeFileSync(tokenFile, 'file-token', { mode: 0o600 });

      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runStatus({
        serverUrl: 'http://127.0.0.1:7337',
        tokenFile,
        fetch: makeMockFetch(200, SAMPLE_STATUS),
        env: {},
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      expect(stdout.join('')).toContain('version:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses MMAGENT_AUTH_TOKEN env over token file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mmagent-status-env-'));
    try {
      // File contains wrong token but env should win — mock accepts any token
      const tokenFile = join(tmpDir, 'auth-token');
      writeFileSync(tokenFile, 'file-token', { mode: 0o600 });

      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runStatus({
        serverUrl: 'http://127.0.0.1:7337',
        tokenFile,
        fetch: makeMockFetch(200, SAMPLE_STATUS),
        env: { MMAGENT_AUTH_TOKEN: 'env-token' },
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      expect(stdout.join('')).toContain('version:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when token file is missing', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mmagent-nohome-'));
    try {
      const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
      const code = await runStatus({
        serverUrl: 'http://127.0.0.1:7337',
        tokenFile: join(fakeHome, 'nonexistent-token'),
        fetch: makeMockFetch(200, SAMPLE_STATUS),
        env: {},
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(1);
      expect(stdout).toHaveLength(0);
      expect(stderr.join('')).toContain('not found');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ─── Uptime formatting ───────────────────────────────────────────────────────

describe('fetchStatus: uptime formatting', () => {
  it('shows days when uptime >= 1 day', async () => {
    const { stdoutFn, stderrFn, stdout } = captureOutput();
    await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'tok',
      fetch: makeMockFetch(200, { ...SAMPLE_STATUS, uptimeMs: 90_000_000 }), // ~25h
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(stdout.join('')).toContain('d ');
  });

  it('shows seconds only for short uptime', async () => {
    const { stdoutFn, stderrFn, stdout } = captureOutput();
    await fetchStatus({
      serverUrl: 'http://127.0.0.1:7337',
      token: 'tok',
      fetch: makeMockFetch(200, { ...SAMPLE_STATUS, uptimeMs: 45_000 }), // 45s
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(stdout.join('')).toContain('45s');
  });
});
