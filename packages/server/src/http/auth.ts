import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadAuthToken as coreLoadAuthToken } from '@zhixuan92/multi-model-agent-core';
import { expandHome } from '../expand-home.js';

/**
 * Load or generate the bearer token from a file path.
 * Respects the MMA_AUTH_TOKEN env override via coreLoadAuthToken when the
 * file already exists. Falls back to generating a new token if the file does not exist.
 */
export function loadToken(tokenPath: string): string {
  const resolved = expandHome(tokenPath);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    // Warn (do not fail) if the existing file has group/other read/write bits set.
    if ((stat.mode & 0o077) !== 0) {
      process.stderr.write(
        `[multi-model-agent] warning: token file ${resolved} has insecure permissions (mode ${(stat.mode & 0o777).toString(8)}); recommend 'chmod 0600 ${resolved}'\n`,
      );
    }
    // Use core's loadAuthToken so the MMA_AUTH_TOKEN env override is respected.
    return coreLoadAuthToken({ tokenFile: resolved });
  }
  return createOrAdoptToken(resolved);
}

/**
 * Mint a token for `resolved`, or adopt the one already there.
 *
 * Exclusive create, not a plain write. `loadToken`'s `existsSync` above is a
 * CHECK, and a check followed by a write is a race: two daemons starting
 * together on a fresh install both see "absent", both mint a token, and the
 * loser keeps a value that is no longer in the file — so every client reading
 * the file gets 401s from it. `wx` makes exactly one process the author;
 * whoever loses reads the winner's token instead of overwriting it.
 *
 * Separated from `loadToken` so the losing branch is reachable in a test
 * without needing two real processes to collide on the same millisecond.
 */
export function createOrAdoptToken(resolved: string): string {
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(resolved, token + '\n', { mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return coreLoadAuthToken({ tokenFile: resolved });
  }
}

/**
 * Validate an Authorization header value (including "Bearer " prefix).
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 *
 * Returns { ok: true } on success.
 * Returns { ok: false, reason } on failure without leaking which check failed.
 */
export function validateAuthHeader(
  header: string | undefined,
  expected: string,
): { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' } {
  if (!header) return { ok: false, reason: 'missing' };
  const parts = header.split(/\s+/);
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  if (parts[0].toLowerCase() !== 'bearer') return { ok: false, reason: 'malformed' };
  const presented = Buffer.from(parts[1]);
  const expectedBuf = Buffer.from(expected);
  if (presented.length !== expectedBuf.length) return { ok: false, reason: 'mismatch' };
  if (!timingSafeEqual(presented, expectedBuf)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
