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
 * Atomic increment. Uses proper-lockfile (already a dep for queue.ts) so two simultaneous
 * `mma telemetry disable` invocations cannot both read N and both write N+1.
 *
 * What a lost bump would actually cost, precisely: the counter is LOCAL. The flusher never puts
 * `generation` in the upload body, and the telemetry backend's schema accepts it as optional
 * passthrough without acting on it — so it is not, and has never been, what stops a revoked
 * install's events being accepted server-side. (Deleting `identity.json` on revoke is what does
 * that: the next event carries a new installId and a new signing key.)
 *
 * Its real job is inside one flush. `flusher.ts` snapshots the generation before uploading,
 * groups records by it, and re-reads it between groups — so a revoke that lands mid-flush stops
 * the remaining groups from going out. A lost bump means that abort does not fire, and a batch
 * queued before the revoke is uploaded after it.
 */
export async function bumpGeneration(dir: string): Promise<number> {
  const p = join(dir, FILE);
  if (!existsSync(p)) writeFileSync(p, '0', { mode: 0o600 });
  const release = await lockfile.lock(p, { retries: { retries: 15, minTimeout: 50, maxTimeout: 500 } });
  try {
    const current = readGeneration(dir);
    const next = current + 1;
    writeFileSync(p, String(next), { mode: 0o600 });
    return next;
  } finally {
    await release();
  }
}
