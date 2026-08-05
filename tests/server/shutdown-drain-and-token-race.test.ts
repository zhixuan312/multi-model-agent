/**
 * Two defects that were identified, recorded, and then left in the backlog —
 * both of which make a promise the code did not keep.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadToken, createOrAdoptToken } from '../../packages/server/src/http/auth.js';

describe('contract: the auth token file has exactly one author', () => {
  it('the loser of a first-start race adopts the winner\'s token instead of clobbering it', () => {
    // This is the branch a real race takes: both daemons passed loadToken's
    // existsSync, and the file appeared underneath the loser before its write.
    // Reaching it directly is the only way to exercise it without two processes
    // colliding on the same millisecond — and going through loadToken instead
    // would short-circuit on existsSync and prove nothing.
    const dir = mkdtempSync(join(tmpdir(), 'mma-token-race-'));
    const tokenPath = join(dir, 'nested', 'auth-token');

    const winner = createOrAdoptToken(tokenPath);       // first process wins
    const loser = createOrAdoptToken(tokenPath);        // second finds it present

    expect(loser, 'the loser must adopt the file, not overwrite it').toBe(winner);
    expect(readFileSync(tokenPath, 'utf8').trim(), 'the file still holds the winner\'s token').toBe(winner);
  });

  it('loadToken returns the token that is actually on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-token-seq-'));
    const tokenPath = join(dir, 'nested', 'auth-token');
    const first = loadToken(tokenPath);
    expect(existsSync(tokenPath)).toBe(true);
    expect(first).toBe(readFileSync(tokenPath, 'utf8').trim());
    expect(loadToken(tokenPath)).toBe(first);
  });

  it('generates a real token on a genuinely fresh path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-token-fresh-'));
    const token = loadToken(join(dir, 'auth-token'));
    expect(token.length).toBeGreaterThan(20);
  });
});

describe('contract: shutdownDrainMs actually bounds a drain', () => {
  // `server.limits.shutdownDrainMs` was schema'd, defaulted to 30s, and named in
  // startServe's own docstring — while the drain it referred to was a literal
  // `Promise.resolve()`. Config that describes behaviour the code does not have
  // is worse than no config: an operator sets it and believes work is protected.
  it('waits for in-flight work and returns once the registry empties', async () => {
    const { drainInFlightTasks } = await import('../../packages/server/src/cli/serve.js');
    let inFlight = 2;
    const lines: string[] = [];
    setTimeout(() => { inFlight = 0; }, 60);

    const started = Date.now();
    await drainInFlightTasks({ allInFlight: () => Array(inFlight).fill(null) }, 5_000, (s) => { lines.push(s); return true; });

    expect(Date.now() - started, 'must not burn the whole budget once empty').toBeLessThan(3_000);
    expect(lines.join('')).toContain('draining 2 in-flight task(s)');
    expect(lines.join('')).toContain('all in-flight tasks finished');
  });

  it('gives up at the budget rather than hanging, and says what was left', async () => {
    const { drainInFlightTasks } = await import('../../packages/server/src/cli/serve.js');
    const lines: string[] = [];
    await drainInFlightTasks({ allInFlight: () => [null] }, 120, (s) => { lines.push(s); return true; });
    expect(lines.join('')).toContain('drain budget elapsed with 1 task(s) still running');
  });

  it('returns immediately when nothing is running', async () => {
    const { drainInFlightTasks } = await import('../../packages/server/src/cli/serve.js');
    const lines: string[] = [];
    await drainInFlightTasks({ allInFlight: () => [] }, 30_000, (s) => { lines.push(s); return true; });
    expect(lines).toEqual([]);
  });
});
