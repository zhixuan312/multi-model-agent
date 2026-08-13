/** In-memory lifecycle states. `interrupted` additionally exists in the
 *  persistent ExecutionStore for executions found dead after a daemon restart —
 *  a live registry never holds it (nothing survives in memory to interrupt). */
export type ExecutionState = 'pending' | 'complete' | 'failed' | 'cancelled';

export interface ExecutionEntry {
  executionId: string;
  cwd: string;
  state: ExecutionState;
  tool: string;
  /** `audit`'s criteria set (`plan` | `spec` | `skill` | `default`), null for every
   *  other type. Carried so a running audit is as self-describing on the wire as it
   *  is in the terminal envelope, which has always split `task.type` from
   *  `task.subtype` — "audit" alone does not say whether a plan or a spec is under
   *  review. */
  subtype: string | null;
  /** The technique `plan` | `execute_plan` | `review` | `debug` requested (currently
   *  only `'software'`), null for every other type AND for those four types when
   *  omitted. Its own field, distinct from `subtype`: `subtype` picks WHAT is being
   *  examined (audit's criteria set), `practice` picks HOW to do the work. Carried
   *  here for the same reason `subtype` is — so a running task is as self-describing
   *  as its terminal envelope. */
  practice: string | null;
  /** The resolved Method identifier (SPEC-005), or `null` when no Method applies. Unlike
   *  `subtype`/`practice` (which are OMITTED from the wire shape when absent), `method` is
   *  always present as `string | null` — see `executionIdentity()` in
   *  `packages/server/src/application/task-identity.ts`, which mirrors this field into the
   *  running snapshot the same way, and the terminal `execution` envelope built in
   *  `execution-runtime.ts`. */
  method: string | null;
  result: unknown;
  runningHeadline: string | null;
  /**
   * When each unit of provider activity landed, and which phase was live at the time.
   *
   * The execution monitor draws a run's shape from this. It has to come from the ENGINE, not
   * from the viewer: the panel used to accumulate its own history from the polls it personally
   * saw, so a re-mounted panel started blank, a second viewer disagreed with the first, and a
   * panel opened on an already-finished task had no history at all. The run's activity is a
   * fact about the run.
   *
   * Timestamps rather than pre-bucketed counts, so a reader can bucket at whatever resolution
   * it renders. Bounded — a long run must not grow this without limit.
   */
  activity: Array<{ at: number; phase: 1 | 2 }>;
  startedAt: number;
  terminalAt: number | null;
  phase: 'implementing' | 'reviewing' | null;
  phaseStartedAt: number | null;
  totalTasks: number | null;
  /** Set when a caller requested cancellation (DELETE /execution/:id). A flag,
   *  not a state: the entry stays `pending` until the runner confirms
   *  termination and the terminal CAS decides between cancelled and a
   *  completed/failed that won the race. */
  cancellationRequestedAt: number | null;
}

function isTerminal(state: ExecutionState): boolean {
  return state === 'complete' || state === 'failed' || state === 'cancelled';
}

/** Default retention for terminal task entries (1h) — matches
 *  DEFAULT_SERVER_LIMITS.batchTtlMs. Long enough that any caller has retrieved
 *  the result via GET /execution/:id well before eviction. */
const DEFAULT_TASK_TTL_MS = 3_600_000;

/**
 * Upper bound on retained activity samples.
 *
 * A busy multi-hour run emits far more provider events than a strip can show, and the oldest
 * are the least interesting. Well above the ~34 buckets any panel renders, so bucketing still
 * has plenty to average over.
 */
const MAX_ACTIVITY_SAMPLES = 600;

export class ExecutionRegistry {
  private entries = new Map<string, ExecutionEntry>();
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

  register(executionId: string, cwd: string, tool: string, subtype: string | null, practice: string | null = null, method: string | null = null): void {
    this.evictExpired(Date.now());
    this.entries.set(executionId, {
      executionId, cwd, tool, subtype, practice, method,
      state: 'pending',
      result: null,
      runningHeadline: null,
      activity: [],
      startedAt: Date.now(),
      terminalAt: null,
      phase: null,
      phaseStartedAt: null,
      totalTasks: null,
      cancellationRequestedAt: null,
    });
  }

  get(executionId: string): ExecutionEntry | undefined {
    return this.entries.get(executionId);
  }

  complete(executionId: string, result: unknown): void {
    const e = this.entries.get(executionId);
    if (!e || isTerminal(e.state)) return;
    e.state = 'complete';
    e.result = result;
    e.terminalAt = Date.now();
  }

  fail(executionId: string, result: unknown): void {
    const e = this.entries.get(executionId);
    if (!e || isTerminal(e.state)) return;
    e.state = 'failed';
    e.result = result;
    e.terminalAt = Date.now();
  }

  /** Terminal transition to `cancelled`. Same CAS discipline as complete/fail:
   *  a task that already reached a terminal state is never overwritten — if
   *  completion won the race against cancellation, completed stands. */
  cancel(executionId: string, result: unknown): void {
    const e = this.entries.get(executionId);
    if (!e || isTerminal(e.state)) return;
    e.state = 'cancelled';
    e.result = result;
    e.terminalAt = Date.now();
  }

  /** Record a cancellation request on a non-terminal task. Returns the outcome
   *  the caller reports: 'requested' (flag set now or already set — idempotent),
   *  'terminal' (too late; entry carries the final state), or 'not_found'. */
  requestCancel(executionId: string): { outcome: 'requested' | 'terminal' | 'not_found'; entry?: ExecutionEntry } {
    const e = this.entries.get(executionId);
    if (!e) return { outcome: 'not_found' };
    if (isTerminal(e.state)) return { outcome: 'terminal', entry: e };
    if (e.cancellationRequestedAt === null) e.cancellationRequestedAt = Date.now();
    return { outcome: 'requested', entry: e };
  }

  setPhase(executionId: string, phase: 'implementing' | 'reviewing'): void {
    const e = this.entries.get(executionId);
    if (!e || isTerminal(e.state)) return;
    e.phase = phase;
    e.phaseStartedAt = Date.now();
  }

  setHeadline(executionId: string, headline: string): void {
    const e = this.entries.get(executionId);
    if (e && !isTerminal(e.state)) e.runningHeadline = headline;
  }

  /**
   * Note that the worker did something. Cheap and lossy on purpose: this runs on every
   * provider event of every concurrent task, and it feeds a strip a few hundred pixels wide.
   *
   * The phase is stamped at record time and never revised, so the history is monotonic by
   * construction — an Act I sample can never appear after an Act II one, which is a sequence
   * the engine cannot actually produce.
   */
  recordActivity(executionId: string, at: number = Date.now()): void {
    const e = this.entries.get(executionId);
    if (!e || isTerminal(e.state)) return;
    e.activity.push({ at, phase: e.phase === 'reviewing' ? 2 : 1 });
    if (e.activity.length > MAX_ACTIVITY_SAMPLES) e.activity.shift();
  }

  countActive(cwd: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.cwd === cwd && !isTerminal(e.state)) n++;
    }
    return n;
  }

  allInFlight(): ExecutionEntry[] {
    return [...this.entries.values()].filter(e => !isTerminal(e.state));
  }

  isTerminal(executionId: string): boolean {
    const e = this.entries.get(executionId);
    return e ? isTerminal(e.state) : false;
  }
}
