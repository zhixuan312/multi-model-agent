import { describe, it, expect } from 'vitest';
import { existsSync, statSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

/**
 * The test suite must never write diagnostics into the developer's own `~/.mma/logs`.
 *
 * This asserted over an ALWAYS-EMPTY byte range. `startTestServer` boots without
 * `diagnosticsLog`, so `LogWriter` leaves its writer null and no JSONL is written anywhere —
 * global or isolated — making the appended range `''` and `expect('').not.toContain(cwd)`
 * true by construction. It also never dispatched a task, so the only record carrying a cwd
 * (`envelope_snapshot`) could not exist even with logging enabled.
 *
 * The mutation it was written to catch survived it: replacing LogWriter's constructor with an
 * unconditional `new JsonlWriter({ dir: join(homedir(), '.mma', 'logs') })` — ignoring both
 * `diagnosticsLog` and `logDir`, i.e. writing every event into the user's real log — kept it
 * green.
 *
 * Now it turns logging ON, runs a real task so an `envelope_snapshot` naming the cwd is
 * produced, proves the isolated log RECEIVED it, and only then asserts the global log did not
 * grow by those bytes. The floor is what makes the second assertion mean anything.
 */
describe('harness writes no events to user global mma log', () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const userLog = join(homedir(), '.mma', 'logs', `mma-${todayUtc}.jsonl`);

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

  /** Everything the harness's own isolated log directory contains. */
  function isolatedLogText(dir: string): string {
    if (!existsSync(dir)) return '';
    return readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('');
  }

  it('routes diagnostics to the isolated log dir, not the user-global jsonl', async () => {
    const sizeBefore = existsSync(userLog) ? statSync(userLog).size : 0;
    const cwd = mkdtempSync(join(tmpdir(), 'harness-iso-'));

    const server = await boot({
      provider: mockProvider({ stage: 'ok' }),
      cwd,
      diagnosticsLog: true,
    });

    try {
      const res = await fetch(`${server.baseUrl}/execution?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-8',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ type: 'investigate', prompt: 'what does this do?' }),
      });
      expect([200, 202]).toContain(res.status);

      // Let the execution reach a terminal state so the envelope snapshot is written.
      for (let i = 0; i < 200; i += 1) {
        if (isolatedLogText(server.logDir).includes(cwd)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      await server.close();
    }

    // FLOOR: diagnostics were actually produced and landed in the isolated dir. Without this the
    // assertion below passes on a server that logged nothing at all — which is exactly how the
    // previous version passed.
    const isolated = isolatedLogText(server.logDir);
    expect(isolated, 'no diagnostics reached the isolated log dir — the check below is vacuous')
      .toContain(cwd);

    // The user-global log is shared with any live `mma serve` on the host, so the file may grow
    // concurrently for unrelated reasons. The contract is "this test server didn't write there":
    // scan only the bytes appended during the window, for our unique mkdtemp cwd.
    const sizeAfter = existsSync(userLog) ? statSync(userLog).size : 0;
    const appended = readRange(userLog, sizeBefore, sizeAfter);
    expect(appended, 'the harness wrote diagnostics into the developer\'s real ~/.mma/logs')
      .not.toContain(cwd);
  }, 30_000);
});
