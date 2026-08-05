/**
 * One provisioning mutation at a time, across processes.
 *
 * Every entry point that provisions is a separate OS process — `mma enable`,
 * `mma disable`, `mma mcp install`, and `mma sync-skills`, which npm's
 * postinstall hook fires on its own schedule. They write into the SAME places,
 * and skill roots are shared by design: one physical copy of `~/.agents/skills`
 * serves cursor, VS Code and opencode. So the realistic collision is not two
 * humans racing; it is a postinstall hook landing while somebody types a
 * command.
 *
 * The ownership proofs elsewhere in this subsystem already make a torn shared
 * root safe — a directory that no longer matches its digest is refused rather
 * than clobbered. This lock is what makes the outcome *useful* instead of merely
 * safe: without it, the loser's work is refused and the user is told to re-run;
 * with it, the loser waits its turn and succeeds.
 *
 * WHY A FILE AND NOT flock(2): Node has no portable advisory-lock binding, and
 * adding a native dependency to a package that already ships to npm is a
 * disproportionate cost. Exclusive create (`wx`) is atomic on every filesystem
 * this runs on, which is the only property the lock actually needs.
 *
 * WHAT MAKES IT SAFE TO STEAL: a crashed holder must not block provisioning
 * forever, but stealing from a LIVE holder would defeat the whole mechanism. So
 * a lock is taken over only when its recorded pid is provably gone — and only
 * when the record was written by this same host, because a pid from another
 * machine says nothing about a process here. An unreadable lock file is treated
 * as a crashed holder once it is older than the stale window, since there is no
 * holder to ask.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from '../pid-alive.js';

/** Written into the lock file so a waiter can identify — and outlive — its holder. */
interface LockRecord {
  pid: number;
  host: string;
  acquiredAt: number;
}

export interface ProvisioningLock {
  /** Release the lock. Safe to call twice; never throws. */
  release(): void;
}

export interface AcquireLockOptions {
  /** Give up after this long and throw. Default 30s — long enough to outlast a
   *  normal provisioning run, short enough that a wedged CLI still returns. */
  timeoutMs?: number;
  /** How long an UNREADABLE lock file must sit before it is assumed abandoned. */
  staleMs?: number;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class ProvisioningLockTimeoutError extends Error {
  readonly code = 'provisioning_locked' as const;
  constructor(path: string, holder: LockRecord | null, waitedMs: number) {
    super(
      holder
        ? `another mma process (pid ${holder.pid} on ${holder.host}) has been provisioning for `
          + `${Math.round((Date.now() - holder.acquiredAt) / 1000)}s; waited ${Math.round(waitedMs / 1000)}s for ${path}. `
          + 'Re-run once it finishes, or remove that file if the process is gone.'
        : `could not acquire ${path} after ${Math.round(waitedMs / 1000)}s.`,
    );
    this.name = 'ProvisioningLockTimeoutError';
  }
}

export function provisioningLockPath(stateDir: string): string {
  return join(stateDir, 'provisioning.lock');
}

function readHolder(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, host, acquiredAt } = parsed as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof acquiredAt !== 'number') return null;
    return { pid, host, acquiredAt };
  } catch {
    return null;
  }
}

/** Whether an existing lock may be taken over — see the module doc. */
function isAbandoned(path: string, holder: LockRecord | null, now: number, staleMs: number): boolean {
  if (holder === null) {
    // No readable holder: only age can distinguish "being written right now"
    // from "left behind by something that died mid-write".
    try {
      return now - statSync(path).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  // A pid is only meaningful on the machine that recorded it.
  if (holder.host !== hostname()) return false;
  return !pidAlive(holder.pid);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the provisioning lock, waiting for a live holder to finish.
 *
 * Throws {@link ProvisioningLockTimeoutError} rather than proceeding unlocked:
 * running anyway is the one outcome this module exists to prevent, and a clear
 * refusal naming the holder is far more actionable than an interleaved write.
 */
export async function acquireProvisioningLock(
  stateDir: string,
  options: AcquireLockOptions = {},
): Promise<ProvisioningLock> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleMs = options.staleMs ?? 60_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const path = provisioningLockPath(stateDir);

  mkdirSync(stateDir, { recursive: true });
  const startedAt = now();
  const mine: LockRecord = { pid: process.pid, host: hostname(), acquiredAt: startedAt };

  for (;;) {
    try {
      writeFileSync(path, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      return { release: () => releaseIfMine(path, mine) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const holder = readHolder(path);
    if (isAbandoned(path, holder, now(), staleMs)) {
      // Remove and loop rather than write over it: an unlink followed by an
      // exclusive create keeps exactly one winner if two waiters both decide to
      // steal at the same moment.
      try { rmSync(path, { force: true }); } catch { /* another waiter got there first */ }
      continue;
    }

    if (now() - startedAt >= timeoutMs) {
      throw new ProvisioningLockTimeoutError(path, holder, now() - startedAt);
    }
    await sleep(100);
  }
}

/** Release only a lock this process still holds. A lock that was stolen after
 *  being judged abandoned now belongs to somebody else, and deleting it would
 *  hand a third process a turn the current holder has not finished with. */
function releaseIfMine(path: string, mine: LockRecord): void {
  const holder = readHolder(path);
  if (holder && (holder.pid !== mine.pid || holder.acquiredAt !== mine.acquiredAt)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort: a lock that cannot be removed is stolen as abandoned once this process exits */
  }
}

/** Run `fn` holding the lock, releasing it on every path including a throw. */
export async function withProvisioningLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
  options?: AcquireLockOptions,
): Promise<T> {
  const lock = await acquireProvisioningLock(stateDir, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
