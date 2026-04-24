/**
 * tests/cli/print-token.test.ts
 *
 * Tests for Task 9.2 — `mmagent print-token` subcommand.
 * Uses temp dirs; never touches real ~/.multi-model or HOME.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { printToken } from '../../packages/server/src/cli/print-token.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mmagent-print-token-test-'));
}

function captureOutput(): { stdout: string[]; stderr: string[]; stdoutFn: (s: string) => boolean; stderrFn: (s: string) => boolean } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (s: string) => { stdout.push(s); return true; },
    stderrFn: (s: string) => { stderr.push(s); return true; },
  };
}

describe('print-token', () => {
  it('prints token from MMAGENT_AUTH_TOKEN env var and exits 0', () => {
    const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
    const code = printToken({
      env: { MMAGENT_AUTH_TOKEN: 'my-secret-token' },
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toBe('my-secret-token\n');
    expect(stderr).toHaveLength(0);
  });

  it('env override wins over token file', () => {
    const tmpDir = makeTempDir();
    try {
      const tokenFile = join(tmpDir, 'auth-token');
      writeFileSync(tokenFile, 'file-token', { mode: 0o600 });
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = printToken({
        tokenFile,
        env: { MMAGENT_AUTH_TOKEN: 'env-token' },
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      expect(stdout.join('')).toBe('env-token\n');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads token from file when env is not set', () => {
    const tmpDir = makeTempDir();
    try {
      const tokenFile = join(tmpDir, 'auth-token');
      writeFileSync(tokenFile, 'file-token\n', { mode: 0o600 });
      const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
      const code = printToken({
        tokenFile,
        env: {},
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      // Token should be trimmed
      expect(stdout.join('')).toBe('file-token\n');
      expect(stderr).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses default token path under homeDir when no tokenFile is provided', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mmagent-fake-home-'));
    try {
      mkdirSync(join(fakeHome, '.multi-model'), { recursive: true });
      const tokenFile = join(fakeHome, '.multi-model', 'auth-token');
      writeFileSync(tokenFile, 'home-token', { mode: 0o600 });
      const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
      const code = printToken({
        homeDir: fakeHome,
        env: {},
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      expect(stdout.join('')).toBe('home-token\n');
      expect(stderr).toHaveLength(0);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('exits 1 with helpful error when token file does not exist', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'mmagent-nohome-'));
    try {
      const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
      const code = printToken({
        homeDir: fakeHome,
        env: {},
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(1);
      expect(stdout).toHaveLength(0);
      const errMsg = stderr.join('');
      expect(errMsg).toContain('not found');
      expect(errMsg).toContain('auth-token');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('exits 1 with explicit error for empty token file', () => {
    const tmpDir = makeTempDir();
    try {
      const tokenFile = join(tmpDir, 'auth-token');
      writeFileSync(tokenFile, '   \n', { mode: 0o600 });
      const { stdoutFn, stderrFn, stdout, stderr } = captureOutput();
      const code = printToken({
        tokenFile,
        env: {},
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(1);
      expect(stdout).toHaveLength(0);
      expect(stderr.join('')).toContain('empty');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('trims whitespace from MMAGENT_AUTH_TOKEN env value', () => {
    const { stdoutFn, stderrFn, stdout } = captureOutput();
    // Env token with surrounding whitespace is trimmed
    const code = printToken({
      env: { MMAGENT_AUTH_TOKEN: '  trimmed-token  ' },
      stdout: stdoutFn,
      stderr: stderrFn,
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toBe('trimmed-token\n');
  });

  it('stdout contains only the token even when stderr has warnings', () => {
    const tmpDir = makeTempDir();
    try {
      const tokenFile = join(tmpDir, 'auth-token');
      writeFileSync(tokenFile, 'canonical-token\n', { mode: 0o600 });
      const cap = captureOutput();
      // Simulate a concurrent warning on stderr before printToken runs; printToken
      // itself must not emit anything extra on stdout.
      cap.stderrFn('[multi-model-agent] WARNING: inline apiKey\n');
      const code = printToken({
        tokenFile,
        env: {},
        stdout: cap.stdoutFn,
        stderr: cap.stderrFn,
      });
      expect(code).toBe(0);
      expect(cap.stdout.join('')).toBe('canonical-token\n');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
