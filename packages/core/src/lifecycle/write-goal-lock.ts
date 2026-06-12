/**
 * Process-global per-repo write-goal mutex. Serializes entire write goal-sets
 * that target the same git repo (keyed by git toplevel, falling back to cwd) so
 * two concurrent same-repo goal-sets never interleave self-commits or collide on
 * `.git`. Distinct repos run concurrently. This replaces the older per-commit
 * mutex (commits are now the agent's, inside one serialized goal-set) and
 * subsumes the journal per-project lock.
 *
 * Single-process scope: in-memory only; single-writer safety assumes one MMA
 * process per repo. Cross-process sharing would need a `.git`-level lockfile.
 */

export const DEFAULT_WRITE_GOAL_LOCK_TIMEOUT_MS = 5 * 60_000;

/** Thrown when lock acquisition exceeds the timeout (request → `write_goal_busy`). */
export class WriteGoalBusyError extends Error {
  readonly code = 'write_goal_busy';
  constructor(repoKey: string, waitedMs: number) {
    super(`write goal lock busy for ${repoKey} after ${waitedMs}ms`);
    this.name = 'WriteGoalBusyError';
  }
}

const chains = new Map<string, Promise<void>>();

/**
 * Run `fn` after any in-flight goal-set for `repoKey` settles; the next caller
 * for the same key waits behind us (FIFO). If waiting for the predecessor
 * exceeds `timeoutMs`, reject with WriteGoalBusyError WITHOUT running `fn`.
 * Releasing our gate early on timeout is safe: our tail still chains on the
 * predecessor, so a later caller never overtakes the still-running holder.
 * Idle keys are deleted so the map can't grow unbounded.
 */
export async function withWriteGoalLock<T>(
  repoKey: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_WRITE_GOAL_LOCK_TIMEOUT_MS,
): Promise<T> {
  const prev = chains.get(repoKey) ?? Promise.resolve();

  // `mine` is the gate the NEXT caller (indirectly) waits on. `tail` chains on
  // the predecessor first, so ordering holds even if we release `mine` early.
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prev.then(() => mine, () => mine);
  chains.set(repoKey, tail);

  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WriteGoalBusyError(repoKey, Date.now() - start)), timeoutMs);
  });

  try {
    // Wait our turn; swallow the predecessor's failure (its own awaiter saw it).
    await Promise.race([prev.then(() => undefined, () => undefined), timeout]);
  } catch (err) {
    release();
    if (chains.get(repoKey) === tail) chains.delete(repoKey);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    return await fn();
  } finally {
    release();
    if (chains.get(repoKey) === tail) chains.delete(repoKey);
  }
}

/** Test-only: current number of tracked repo keys. */
export function __writeGoalLockMapSizeForTest(): number {
  return chains.size;
}
