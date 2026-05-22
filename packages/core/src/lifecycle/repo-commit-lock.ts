/**
 * Process-global per-repo commit mutex. Serializes commits that target the
 * same git repo (keyed by git toplevel, falling back to cwd) so two
 * concurrent same-repo workers never collide on `.git/index.lock`. Distinct
 * keys run concurrently. The lock wraps ONLY the git staging+commit section
 * in git-commit-handler.ts — never read-only probes or worker execution.
 *
 * Single-process scope (spec P5): this mutex serializes within one core
 * process only. If cross-process concurrent execution against a shared repo
 * becomes possible, upgrade to an inter-process (file) lock.
 */

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any in-flight work for `repoKey` settles; the next caller for
 * the same key waits for `fn`. Always releases on throw (the chain advances
 * past a rejected fn). Idle keys are deleted so the map can't grow unbounded.
 */
export async function withRepoCommitLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(repoKey) ?? Promise.resolve();
  // Swallow the predecessor's rejection for *scheduling* purposes only — a
  // failed prior commit must not reject this caller. The predecessor's own
  // awaiter already saw the rejection.
  const runAfter = prev.then(fn, fn);
  chains.set(repoKey, runAfter);

  try {
    return await runAfter;
  } finally {
    // If we're still the tail of the chain (nobody queued behind us), drop the
    // key so the map stays bounded over the daemon's lifetime.
    if (chains.get(repoKey) === runAfter) {
      chains.delete(repoKey);
    }
  }
}

/** Test-only: current number of tracked repo keys. */
export function __repoLockMapSizeForTest(): number {
  return chains.size;
}
