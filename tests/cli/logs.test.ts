import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextFollowTarget, runLogs } from '../../packages/server/src/cli/logs.js';
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

// No casts: `runLogs` asks only for `diagnostics`, so that is all this builds. It used to fake an
// empty `agents` and `server` and cast three times to satisfy a parameter type the function never
// touched — which also meant a real change to either of those shapes could not be noticed here.
function mkConfig(logDir: string, enabled = true): Pick<MultiModelConfig, 'diagnostics'> {
  return { diagnostics: { log: enabled, logDir } };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeLog(logDir: string, lines: string[]): string {
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, `mma-${today()}.jsonl`);
  writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return file;
}

describe('mma logs', () => {
  it('prints existing log file contents to stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-batch-'));
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

  it('--batch matches every real log id key form (taskId, task_id, batch_id, batchId)', async () => {
    // The JSONL log emits the task/batch id under several key spellings depending
    // on the writer (plain entries use snake_case fields.task_id/batch_id; envelope
    // snapshots use taskId; wire records use batchId). --batch must catch them ALL,
    // otherwise it silently drops most of a task's diagnostic events.
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-batch-forms-'));
    try {
      writeLog(dir, [
        JSON.stringify({ ts: '1', kind: 'batch_created', fields: { batch_id: 'B', tool: 'delegate' } }),
        JSON.stringify({ ts: '2', taskId: 'B', kind: 'seal' }),
        JSON.stringify({ ts: '3', kind: 'task_started', fields: { task_id: 'B' } }),
        JSON.stringify({ event: 'wire', batchId: 'B' }),
        JSON.stringify({ ts: '4', taskId: 'OTHER', kind: 'seal' }),
      ]);
      const c = cap();
      const code = await runLogs({ config: mkConfig(dir), homeDir: dir, batchId: 'B', stdout: c.outFn, stderr: c.errFn });
      expect(code).toBe(0);
      const lines = c.out.join('').trim().split('\n').filter(Boolean);
      // All 4 lines for task B must appear; the OTHER line must be excluded.
      expect(lines.length).toBe(4);
      expect(lines.some((l) => l.includes('OTHER'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('nextFollowTarget — what a --follow session reads next', () => {
    it('switches to the new file when the log rotates at UTC midnight', () => {
      // The writer moves to mma-<date>.jsonl at midnight. A session started yesterday used to keep
      // tailing yesterday's file and go silent for the rest of the run, which to a user is
      // indistinguishable from "nothing is happening".
      const next = nextFollowTarget(
        { path: '/logs/mma-2026-08-14.jsonl', offset: 4096 },
        '/logs/mma-2026-08-15.jsonl',
        true,
        4096,
      );
      expect(next).toEqual({ path: '/logs/mma-2026-08-15.jsonl', offset: 0 });
    });

    it('stays put when the newly resolved file does not exist yet', () => {
      // Just after midnight the new file may not have been created. Switching to a path that is
      // not there would lose the lines still arriving in the old one.
      const next = nextFollowTarget(
        { path: '/logs/mma-2026-08-14.jsonl', offset: 4096 },
        '/logs/mma-2026-08-15.jsonl',
        false,
        5000,
      );
      expect(next).toEqual({ path: '/logs/mma-2026-08-14.jsonl', offset: 4096 });
    });

    it('rewinds when the file was truncated under us', () => {
      // size < offset means the file shrank. Without the rewind, `size <= offset` skipped every
      // later poll and the tail never emitted another line.
      const next = nextFollowTarget({ path: '/logs/a.jsonl', offset: 4096 }, '/logs/a.jsonl', true, 100);
      expect(next).toEqual({ path: '/logs/a.jsonl', offset: 0 });
    });

    it('leaves a normally-growing file alone', () => {
      const current = { path: '/logs/a.jsonl', offset: 4096 };
      expect(nextFollowTarget(current, '/logs/a.jsonl', true, 8192)).toBe(current);
    });
  });

  it('no log file + no --follow exits 0 with warning on stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-empty-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-follow-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-disabled-'));
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
    const dir = mkdtempSync(join(tmpdir(), 'mma-logs-tail-'));
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
