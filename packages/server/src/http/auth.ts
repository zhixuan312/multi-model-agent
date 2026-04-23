import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadAuthToken as coreLoadAuthToken } from '@zhixuan92/multi-model-agent-core';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Load or generate the bearer token from a file path.
 * Respects the MMAGENT_AUTH_TOKEN env override via coreLoadAuthToken when the
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
    // Use core's loadAuthToken so the MMAGENT_AUTH_TOKEN env override is respected.
    return coreLoadAuthToken({ tokenFile: resolved });
  }
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  fs.writeFileSync(resolved, token + '\n', { mode: 0o600 });
  return token;
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

/**
 * Convenience wrapper with boolean return — used by the server pipeline.
 * Accepts the raw Authorization header value (e.g. "Bearer abc123") and
 * the expected token string (without "Bearer " prefix).
 */
export function validateBearerHeader(header: string | undefined, expectedToken: string): boolean {
  return validateAuthHeader(header, expectedToken).ok;
}
