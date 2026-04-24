import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLogs } from '../../packages/server/src/cli/logs.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    outFn: (s: string) => { out.push(s); return true; },
    errFn: (s: string) => { err.push(s); return true; },
  };
}

function mkConfig(logDir: string, enabled = true): MultiModelConfig {
  return {
    agents: {} as MultiModelConfig['agents'],
    defaults: { parentModel: '', tools: 'full', timeoutMs: 60_000, maxCostUSD: 10, sandboxPolicy: 'cwd-only' },
    diagnostics: { log: enabled, logDir },
    server: {} as MultiModelConfig['server'],
  } as MultiModelConfig;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeLog(logDir: string, lines: string[]): string {
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, `mmagent-${today()}.jsonl`);
  writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return file;
}

describe('mmagent logs', () => {
  it('prints existing log file contents to stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-logs-'));
    try {
      writeLog(dir, [
        JSON.stringify({ event: 'startup', pid: 1 }),
        JSON.stringify({ event: 'request_start', batchId: 'b1', tool: 'delegate' }),
      ]);
      const c = cap();
      const code = await runLogs({ config: mkConfig(dir), homeDir: dir, stdout: c.outFn, stderr: c.errFn });
      expect(code).toBe(0);
      const out = c.out.join('');
      expect(out).toMatch(/"event":"startup"/);
      expect(out).toMatch(/"batchId":"b1"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--batch filters lines by batchId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-logs-batch-'));
    try {
      writeLog(dir, [
        JSON.stringify({ event: 'request_start', batchId: 'b1' }),
        JSON.stringify({ event: 'request_start', batchId: 'b2' }),
        JSON.stringify({ event: 'task_started', batchId: 'b1' }),
      ]);
      const c = cap();
      const code = await runLogs({
        config: mkConfig(dir),
        homeDir: dir,
        batchId: 'b1',
        stdout: c.outFn,
        stderr: c.errFn,
      });
      expect(code).toBe(0);
      const lines = c.out.join('').trim().split('\n');
      expect(lines.every((l) => l.includes('"batchId":"b1"'))).toBe(true);
      expect(lines.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no log file + no --follow exits 0 with warning on stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-logs-empty-'));
    try {
      const c = cap();
      const code = await runLogs({ config: mkConfig(dir), homeDir: dir, stdout: c.outFn, stderr: c.errFn });
      expect(code).toBe(0);
      expect(c.err.join('')).toMatch(/no log file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no log file + --follow waits then exits 0 when wait elapses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-logs-follow-'));
    try {
      const c = cap();
      const code = await runLogs({
        config: mkConfig(dir),
        homeDir: dir,
        follow: true,
        waitForLogMs: 200,
        pollMs: 50,
        stdout: c.outFn,
        stderr: c.errFn,
      });
      expect(code).toBe(0);
      expect(c.err.join('')).toMatch(/no log file appeared/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('diagnostics.log: false logs a helpful stderr warning and still tails existing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-logs-disabled-'));
    try {
      writeLog(dir, [JSON.stringify({ event: 'startup' })]);
      const c = cap();
      const code = await runLogs({ config: mkConfig(dir, false), homeDir: dir, stdout: c.outFn, stderr: c.errFn });
      expect(code).toBe(0);
      expect(c.err.join('')).toMatch(/diagnostics\.log is false/);
      expect(c.out.join('')).toMatch(/"event":"startup"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--follow tails new writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmagent-logs-tail-'));
    try {
      const logFile = writeLog(dir, [JSON.stringify({ event: 'startup' })]);
      const c = cap();
      // Start follow in background and append a line shortly after.
      const runPromise = runLogs({
        config: mkConfig(dir),
        homeDir: dir,
        follow: true,
        pollMs: 40,
        stdout: c.outFn,
        stderr: c.errFn,
      });
      // Give the first emit a moment, then append.
      await new Promise((r) => setTimeout(r, 50));
      appendFileSync(logFile, JSON.stringify({ event: 'request_start', batchId: 'tail-b' }) + '\n');
      // Wait long enough for the poll loop to pick it up.
      await new Promise((r) => setTimeout(r, 300));
      // Abort the infinite follow by race-rejecting (we discard the result).
      const timedOut = Promise.race([
        runPromise,
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ]);
      await timedOut;
      const out = c.out.join('');
      expect(out).toMatch(/"event":"startup"/);
      expect(out).toMatch(/"batchId":"tail-b"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
