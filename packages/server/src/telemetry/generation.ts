import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

const FILE = 'telemetry-generation';

export function readGeneration(dir: string): number {
  const p = join(dir, FILE);
  if (!existsSync(p)) return 0;
  const n = Number.parseInt(readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Atomic increment. Uses proper-lockfile so two simultaneous
 * invocations cannot both read N and both write N+1.
 */
export async function bumpGeneration(dir: string): Promise<number> {
  const p = join(dir, FILE);
  if (!existsSync(p)) writeFileSync(p, '0', { mode: 0o600 });
  const release = await lockfile.lock(p, { retries: { retries: 50, minTimeout: 10, maxTimeout: 100 } });
  try {
    const current = readGeneration(dir);
    const next = current + 1;
    writeFileSync(p, String(next), { mode: 0o600 });
    return next;
  } finally {
    await release();
  }
}
