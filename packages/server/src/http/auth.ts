import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadToken(tokenPath: string): string {
  const resolved = expandHome(tokenPath);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    // Warn (do not fail) if the existing file has group/other read/write bits set.
    // Failing hard would break users who already have a token file with default umask.
    if ((stat.mode & 0o077) !== 0) {
      process.stderr.write(
        `[multi-model-agent] warning: token file ${resolved} has insecure permissions (mode ${(stat.mode & 0o777).toString(8)}); recommend 'chmod 0600 ${resolved}'\n`,
      );
    }
    return fs.readFileSync(resolved, 'utf8').trim();
  }
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  fs.writeFileSync(resolved, token + '\n', { mode: 0o600 });
  return token;
}

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
