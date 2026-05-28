/**
 * Per-project (per-cwd) async mutex for journal writes. Chained-promise
 * implementation: each caller awaits the previous caller's tail before running.
 * Distinct cwds never block each other. The map entry is removed once the last
 * queued caller for a cwd completes, so lock state grows only with active
 * contention. On a contended acquire, one stderr breadcrumb is emitted; an
 * uncontended acquire emits nothing.
 */
const tails = new Map<string, Promise<void>>();

export async function withProjectJournalLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(cwd);               // undefined => uncontended
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = (prev ?? Promise.resolve()).then(() => mine);
  tails.set(cwd, tail);

  const start = Date.now();
  if (prev) {
    await prev;                              // queue behind the current holder
    process.stderr.write(
      `[mmagent] event=journal_lock_wait cwd=${cwd} wait_ms=${Date.now() - start}\n`,
    );
  }
  try {
    return await fn();
  } finally {
    release();                               // let the next waiter proceed
    if (tails.get(cwd) === tail) tails.delete(cwd); // nobody queued behind us
  }
}

/** Test-only: number of cwds with a live lock tail. */
export function __journalLockMapSize(): number {
  return tails.size;
}
