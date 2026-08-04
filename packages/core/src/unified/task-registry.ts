/** In-memory lifecycle states. `interrupted` additionally exists in the
 *  persistent ExecutionStore for executions found dead after a daemon restart —
 *  a live registry never holds it (nothing survives in memory to interrupt). */
export type TaskState = 'pending' | 'complete' | 'failed' | 'cancelled';

export interface TaskEntry {
  taskId: string;
  cwd: string;
  state: TaskState;
  tool: string;
  /** `audit`'s criteria set (`plan` | `spec` | `skill` | `default`), null for every
   *  other type. Carried so a running audit is as self-describing on the wire as it
   *  is in the terminal envelope, which has always split `task.type` from
   *  `task.subtype` — "audit" alone does not say whether a plan or a spec is under
   *  review. */
  subtype: string | null;
  result: unknown;
  runningHeadline: string | null;
  startedAt: number;
  terminalAt: number | null;
  phase: 'implementing' | 'reviewing' | null;
  phaseStartedAt: number | null;
  totalTasks: number | null;
  /** Set when a caller requested cancellation (DELETE /task/:id). A flag, not a
   *  state: the entry stays `pending` until the runner confirms termination and
   *  the terminal CAS decides between cancelled and a completed/failed that won
   *  the race. */
  cancellationRequestedAt: number | null;
}

function isTerminal(state: TaskState): boolean {
  return state === 'complete' || state === 'failed' || state === 'cancelled';
}

/** Default retention for terminal task entries (1h) — matches
 *  DEFAULT_SERVER_LIMITS.batchTtlMs. Long enough that any caller has retrieved
 *  the result via GET /task/:id well before eviction. */
const DEFAULT_TASK_TTL_MS = 3_600_000;

export class TaskRegistry {
  private entries = new Map<string, TaskEntry>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TASK_TTL_MS;
  }

  /** Drop terminal entries whose result has been retrievable longer than the TTL.
   *  In-flight (non-terminal) entries are never evicted regardless of age — a
   *  slow task must never disappear mid-run. Runs lazily on register(), so a busy
   *  server bounds its own memory without a background timer. */
  private evictExpired(now: number): void {
    for (const [id, e] of this.entries) {
      if (e.terminalAt !== null && now - e.terminalAt > this.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  register(taskId: string, cwd: string, tool: string, subtype: string | null = null): void {
    this.evictExpired(Date.now());
    this.entries.set(taskId, {
      taskId, cwd, tool, subtype,
      state: 'pending',
      result: null,
      runningHeadline: null,
      startedAt: Date.now(),
      terminalAt: null,
      phase: null,
      phaseStartedAt: null,
      totalTasks: null,
      cancellationRequestedAt: null,
    });
  }

  get(taskId: string): TaskEntry | undefined {
    return this.entries.get(taskId);
  }

  complete(taskId: string, result: unknown): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.state)) return;
    e.state = 'complete';
    e.result = result;
    e.terminalAt = Date.now();
  }

  fail(taskId: string, result: unknown): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.state)) return;
    e.state = 'failed';
    e.result = result;
    e.terminalAt = Date.now();
  }

  /** Terminal transition to `cancelled`. Same CAS discipline as complete/fail:
   *  a task that already reached a terminal state is never overwritten — if
   *  completion won the race against cancellation, completed stands. */
  cancel(taskId: string, result: unknown): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.state)) return;
    e.state = 'cancelled';
    e.result = result;
    e.terminalAt = Date.now();
  }

  /** Record a cancellation request on a non-terminal task. Returns the outcome
   *  the caller reports: 'requested' (flag set now or already set — idempotent),
   *  'terminal' (too late; entry carries the final state), or 'not_found'. */
  requestCancel(taskId: string): { outcome: 'requested' | 'terminal' | 'not_found'; entry?: TaskEntry } {
    const e = this.entries.get(taskId);
    if (!e) return { outcome: 'not_found' };
    if (isTerminal(e.state)) return { outcome: 'terminal', entry: e };
    if (e.cancellationRequestedAt === null) e.cancellationRequestedAt = Date.now();
    return { outcome: 'requested', entry: e };
  }

  setPhase(taskId: string, phase: 'implementing' | 'reviewing'): void {
    const e = this.entries.get(taskId);
    if (!e || isTerminal(e.state)) return;
    e.phase = phase;
    e.phaseStartedAt = Date.now();
  }

  setHeadline(taskId: string, headline: string): void {
    const e = this.entries.get(taskId);
    if (e && !isTerminal(e.state)) e.runningHeadline = headline;
  }

  countActive(cwd: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.cwd === cwd && !isTerminal(e.state)) n++;
    }
    return n;
  }

  allInFlight(): TaskEntry[] {
    return [...this.entries.values()].filter(e => !isTerminal(e.state));
  }

  isTerminal(taskId: string): boolean {
    const e = this.entries.get(taskId);
    return e ? isTerminal(e.state) : false;
  }
}
