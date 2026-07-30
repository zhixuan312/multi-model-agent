// ExecutionScope — the per-execution lifetime object created BEFORE any
// preprocessing runs. It owns the execution's abort channel (the single signal
// every provider session opened on behalf of this execution must receive) and
// a cleanup registry drained in one `finally`, so resources acquired anywhere
// in the execution path (context-block pins today; process handles and
// worktree ownership as the lifecycle grows) are released even when the
// pipeline throws.

export class ExecutionScope {
  readonly executionId: string;
  private readonly ac = new AbortController();
  private readonly cleanups: Array<() => void | Promise<void>> = [];

  constructor(executionId: string) {
    this.executionId = executionId;
  }

  /** The execution's abort signal. Every provider session opened on behalf of
   *  this execution — preprocessing turns included — must receive THIS signal,
   *  never a throwaway `new AbortController().signal`. */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** Fire the execution's abort channel (cooperative cancellation). */
  abort(reason?: string): void {
    this.ac.abort(reason);
  }

  /** Register a release action to run when the execution ends (LIFO). */
  registerCleanup(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn);
  }

  /** Run all registered cleanups newest-first. Best-effort: a throwing cleanup
   *  never blocks the others. Idempotent — a second drain is a no-op. */
  async drain(): Promise<void> {
    while (this.cleanups.length > 0) {
      const fn = this.cleanups.pop()!;
      try { await fn(); } catch { /* best-effort */ }
    }
  }
}
