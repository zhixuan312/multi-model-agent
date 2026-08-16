/**
 * `POST /configure-provider` must not stop the daemon answering anything else.
 *
 * Verifying a codex tier really spawns `codex --version`. That check was `execFileSync` with a
 * 10-second timeout — twice the handler's own `PROBE_TIMEOUT_MS`, spent BLOCKING the event loop —
 * so a single operator request naming a codex tier could freeze the whole daemon, `/health`
 * included, for up to ten seconds. `scripts/full-smoke/availability.mjs` exists specifically to
 * detect that shape ("always HTTP-layer while workers keep running — check for synchronous work
 * on the daemon event loop"), and here it was reachable straight from the request path.
 *
 * The test drives the real server with `MMA_CODEX_BIN` pointed at a script that sleeps, then
 * checks `/health` still answers while the configure request is in flight. With a synchronous
 * spawn, `/health` cannot be served until the sleep finishes; with an async one, it is served
 * immediately.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer } from '../helpers/test-server.js';

/** A fake `codex` that takes ~1.5s to answer `--version`. */
const SLEEP_SECONDS = 1.5;

let binDir: string;
let previousBin: string | undefined;
let server: TestServer;

beforeAll(async () => {
  binDir = mkdtempSync(join(tmpdir(), 'mma-slow-codex-'));
  const script = join(binDir, 'slow-codex');
  writeFileSync(script, `#!/usr/bin/env bash\nsleep ${SLEEP_SECONDS}\necho "codex 1.0.0"\n`, 'utf8');
  chmodSync(script, 0o755);

  previousBin = process.env.MMA_CODEX_BIN;
  process.env.MMA_CODEX_BIN = script;
  server = await startTestServer();
});

afterAll(async () => {
  await server.stop();
  if (previousBin === undefined) delete process.env.MMA_CODEX_BIN;
  else process.env.MMA_CODEX_BIN = previousBin;
  rmSync(binDir, { recursive: true, force: true });
});

describe('configure-provider does not block the event loop', () => {
  /**
   * Measured as EVENT-LOOP LAG, not as a second request's latency.
   *
   * The obvious version of this test — fire the configure request, wait, then time a `/health`
   * round-trip — cannot work, and it is worth recording why: the test runs on the same event loop
   * as the server, so a blocking spawn stops the TEST too. `Date.now()` before the fetch does not
   * execute until the block is already over, and the measurement comes back at a few milliseconds
   * whether or not the loop was frozen. Written that way it passed against `execFileSync`.
   *
   * A timer scheduled BEFORE the request does observe it: a blocked loop cannot fire timers, so
   * the gap between consecutive ticks grows to the length of the block, and the lateness is still
   * visible once the loop resumes.
   */
  it('keeps firing timers while a codex tier verification is in flight', async () => {
    const ticks: number[] = [];
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      ticks.push(now - last);
      last = now;
    }, 25);

    try {
      const response = await fetch(`${server.url}/configure-provider`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`,
          'X-MMA-Client': 'claude-code',
        },
        body: JSON.stringify({
          tier: 'standard',
          provider: 'codex',
          model: 'gpt-5',
          auth: { mode: 'api-key', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1/v1' },
          dryRun: true,
        }),
      });
      expect(response.status).toBe(200);
    } finally {
      clearInterval(timer);
    }

    // The spawn takes ~1.5s. Blocking it holds every tick; a handful of 25ms ticks must have
    // landed during that window instead.
    expect(ticks.length, 'no timer ticks observed — the interval never ran').toBeGreaterThan(5);
    const worstGap = Math.max(...ticks);
    expect(worstGap, `worst timer gap was ${worstGap}ms — the event loop was blocked`)
      .toBeLessThan((SLEEP_SECONDS * 1000) / 2);
  }, 20_000);
});
