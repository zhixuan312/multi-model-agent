export type TaskState = 'pending' | 'complete' | 'failed';

export interface TaskEntry {
  taskId: string;
  cwd: string;
  state: TaskState;
  tool: string;
  result: unknown;
  runningHeadline: string | null;
  startedAt: number;
  terminalAt: number | null;
  phase: 'implementing' | 'reviewing' | null;
  phaseStartedAt: number | null;
  totalTasks: number | null;
}

function isTerminal(state: TaskState): boolean {
  return state === 'complete' || state === 'failed';
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

  register(taskId: string, cwd: string, tool: string): void {
    this.evictExpired(Date.now());
    this.entries.set(taskId, {
      taskId, cwd, tool,
      state: 'pending',
      result: null,
      runningHeadline: null,
      startedAt: Date.now(),
      terminalAt: null,
      phase: null,
      phaseStartedAt: null,
      totalTasks: null,
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
