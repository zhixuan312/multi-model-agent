import { describe, it, expect } from 'bun:test';
import { existsSync, statSync, mkdtempSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { startTestServer } from '../fixtures/start-test-server.js';

describe('harness writes no events to user global mmagent log', () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const userLog = join(homedir(), '.multi-model', 'logs', `mmagent-${todayUtc}.jsonl`);

  // Read bytes appended to `path` in the [from, to) range. Returns empty
  // string if the range is empty or the file is gone. Reading by offset
  // (not whole-file slurp) keeps this safe for a growing log.
  function readRange(path: string, from: number, to: number): string {
    if (!existsSync(path) || to <= from) return '';
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      readSync(fd, buf, 0, to - from, from);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  it('does not append to user-global jsonl during a test-server lifecycle', async () => {
    const sizeBefore = existsSync(userLog) ? statSync(userLog).size : 0;
    const cwd = mkdtempSync(join(tmpdir(), 'harness-iso-'));
    const server = await startTestServer({ cwd });
    await server.close();
    const sizeAfter = existsSync(userLog) ? statSync(userLog).size : 0;

    // The user-global log is shared with any live `mmagent serve` on the
    // host, so the file may grow concurrently for reasons unrelated to
    // this test. The contract under test is "this test server didn't
    // write to the user-global log" — check that by scanning the bytes
    // appended during the test window for a reference to our isolated
    // cwd (mkdtempSync guarantees uniqueness, so no false positives).
    const appended = readRange(userLog, sizeBefore, sizeAfter);
    expect(appended).not.toContain(cwd);
  });
});
