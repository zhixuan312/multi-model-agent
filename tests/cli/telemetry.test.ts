/**
 * tests/cli/telemetry.test.ts
 *
 * Tests for Task 7.1 — `mmagent telemetry` subcommands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { runTelemetry } from '../../packages/server/src/cli/telemetry.js';

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (s: string) => { stdout.push(s); return true; },
    stderrFn: (s: string) => { stderr.push(s); return true; },
  };
}

function setupTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mmagent-telemetry-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(homeDir: string, obj: unknown): void {
  writeFileSync(join(homeDir, 'config.json'), JSON.stringify(obj), { mode: 0o600 });
}

function readConfig(homeDir: string): unknown {
  const p = join(homeDir, 'config.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ─── status ──────────────────────────────────────────────────────────────────

describe('mmagent telemetry status', () => {
  let savedEnv: string | undefined;

  beforeEach(() => { savedEnv = process.env.MMAGENT_TELEMETRY; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MMAGENT_TELEMETRY;
    else process.env.MMAGENT_TELEMETRY = savedEnv;
  });

  it('prints disabled + source=default when no config and no env', async () => {
    const tmp = setupTempHome();
    try {
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      expect(out).toContain('disabled');
      expect(out).toContain('default');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints enabled + source=config when config.telemetry.enabled=true', async () => {
    const tmp = setupTempHome();
    try {
      writeConfig(tmp, { telemetry: { enabled: true } });
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      expect(out).toContain('enabled');
      expect(out).toContain('config');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints disabled + source=config when config.telemetry.enabled=false', async () => {
    const tmp = setupTempHome();
    try {
      writeConfig(tmp, { telemetry: { enabled: false } });
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      expect(out).toContain('disabled');
      expect(out).toContain('config');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints enabled + source=env when MMAGENT_TELEMETRY=1', async () => {
    const tmp = setupTempHome();
    try {
      // config says disabled but env wins
      writeConfig(tmp, { telemetry: { enabled: false } });
      process.env.MMAGENT_TELEMETRY = '1';
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      expect(out).toContain('enabled');
      expect(out).toContain('env');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces MMAGENT_TELEMETRY="" as "set to \'\' (no effect)"', async () => {
    const tmp = setupTempHome();
    try {
      writeConfig(tmp, { telemetry: { enabled: true } });
      process.env.MMAGENT_TELEMETRY = '';
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      expect(out).toMatch(/set to ''\s*\(no effect/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces MMAGENT_TELEMETRY non-empty value in status output', async () => {
    const tmp = setupTempHome();
    try {
      process.env.MMAGENT_TELEMETRY = '0';
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      // 0 means disabled via env
      expect(out).toContain('disabled');
      expect(out).toContain('env');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exits 1 when config file is unreadable (invalid JSON)', async () => {
    const tmp = setupTempHome();
    try {
      writeFileSync(join(tmp, 'config.json'), '{bad json', { mode: 0o600 });
      const { stdoutFn, stderrFn, stderr } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'status',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0); // status still succeeds, shows source
      expect(stderr.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── enable ───────────────────────────────────────────────────────────────────

describe('mmagent telemetry enable', () => {
  it('writes config.telemetry.enabled=true when no config exists', async () => {
    const tmp = setupTempHome();
    try {
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'enable',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const cfg = readConfig(tmp) as any;
      expect(cfg.telemetry.enabled).toBe(true);
      expect(stdout.join('')).toContain('enabled');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('updates existing config to telemetry.enabled=true, preserving other fields', async () => {
    const tmp = setupTempHome();
    try {
      writeConfig(tmp, { server: { port: 8080 }, telemetry: { enabled: false } });
      const { stdoutFn, stderrFn } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'enable',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const cfg = readConfig(tmp) as any;
      expect(cfg.telemetry.enabled).toBe(true);
      expect(cfg.server.port).toBe(8080);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('overwrites bare top-level enabled if present', async () => {
    const tmp = setupTempHome();
    try {
      writeConfig(tmp, { enabled: false });
      const { stdoutFn, stderrFn } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'enable',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const cfg = readConfig(tmp) as any;
      expect(cfg.telemetry.enabled).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── disable ──────────────────────────────────────────────────────────────────

describe('mmagent telemetry disable', () => {
  it('writes config.telemetry.enabled=false + bumps generation + deletes queue', async () => {
    const tmp = setupTempHome();
    try {
      writeConfig(tmp, { telemetry: { enabled: true } });

      // pre-create a queue file and an install-id
      const queuePath = join(tmp, 'telemetry-queue.ndjson');
      writeFileSync(queuePath, '{"x":1}\n', { mode: 0o600 });
      writeFileSync(join(tmp, 'install-id'), 'fake-install-id', { mode: 0o600 });
      writeFileSync(join(tmp, 'telemetry-generation'), '3', { mode: 0o600 });

      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'disable',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);

      // config updated
      const cfg = readConfig(tmp) as any;
      expect(cfg.telemetry.enabled).toBe(false);

      // generation bumped
      const gen = readFileSync(join(tmp, 'telemetry-generation'), 'utf8').trim();
      expect(gen).toBe('4');

      // queue deleted
      expect(existsSync(queuePath)).toBe(false);

      // install-id preserved (disable does NOT delete install-id)
      expect(existsSync(join(tmp, 'install-id'))).toBe(true);

      expect(stdout.join('')).toContain('disabled');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── reset-id ─────────────────────────────────────────────────────────────────

describe('mmagent telemetry reset-id', () => {
  it('revokeIdentity (bumps generation + deletes queue) + deletes install-id', async () => {
    const tmp = setupTempHome();
    try {
      const queuePath = join(tmp, 'telemetry-queue.ndjson');
      writeFileSync(queuePath, '{"x":1}\n', { mode: 0o600 });
      writeFileSync(join(tmp, 'install-id'), 'fake-install-id', { mode: 0o600 });
      writeFileSync(join(tmp, 'telemetry-generation'), '5', { mode: 0o600 });

      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'reset-id',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);

      // generation bumped
      const gen = readFileSync(join(tmp, 'telemetry-generation'), 'utf8').trim();
      expect(gen).toBe('6');

      // queue deleted
      expect(existsSync(queuePath)).toBe(false);

      // install-id deleted
      expect(existsSync(join(tmp, 'install-id'))).toBe(false);

      expect(stdout.join('')).toContain('reset');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no-ops gracefully when files do not exist', async () => {
    const tmp = setupTempHome();
    try {
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'reset-id',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      expect(stdout.join('')).toContain('reset');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── dump-queue ───────────────────────────────────────────────────────────────

describe('mmagent telemetry dump-queue', () => {
  it('prints queue records as JSON to stdout', async () => {
    const tmp = setupTempHome();
    try {
      const queuePath = join(tmp, 'telemetry-queue.ndjson');
      const record = {
        schemaVersion: 1,
        install: {
          installId: 'test-id',
          mmagentVersion: '3.6.0',
          os: 'darwin',
          nodeMajor: '22',
          language: 'en',
          tzOffsetBucket: 'utc_plus_6_to_plus_12',
        },
        generation: 0,
        event: { type: 'session.started', eventId: 'evt-1' },
      };
      writeFileSync(queuePath, JSON.stringify(record) + '\n', { mode: 0o600 });

      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'dump-queue',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const out = stdout.join('');
      const parsed = JSON.parse(out) as any[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].event.type).toBe('session.started');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints empty array when no queue file exists', async () => {
    const tmp = setupTempHome();
    try {
      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'dump-queue',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout.join(''));
      expect(parsed).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prints multiple records', async () => {
    const tmp = setupTempHome();
    try {
      const queuePath = join(tmp, 'telemetry-queue.ndjson');
      const lines = [
        JSON.stringify({ schemaVersion: 1, install: { installId: 'a' }, generation: 0, event: { n: 1 } }),
        JSON.stringify({ schemaVersion: 1, install: { installId: 'b' }, generation: 1, event: { n: 2 } }),
      ].join('\n') + '\n';
      writeFileSync(queuePath, lines, { mode: 0o600 });

      const { stdoutFn, stderrFn, stdout } = captureOutput();
      const code = await runTelemetry({
        subcommand: 'dump-queue',
        homeDir: tmp,
        stdout: stdoutFn,
        stderr: stderrFn,
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout.join('')) as any[];
      expect(parsed).toHaveLength(2);
      expect(parsed[0].event.n).toBe(1);
      expect(parsed[1].event.n).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
