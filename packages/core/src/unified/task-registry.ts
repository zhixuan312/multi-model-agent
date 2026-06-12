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
}

function isTerminal(state: TaskState): boolean {
  return state === 'complete' || state === 'failed';
}

export class TaskRegistry {
  private entries = new Map<string, TaskEntry>();

  register(taskId: string, cwd: string, tool: string): void {
    this.entries.set(taskId, {
      taskId, cwd, tool,
      state: 'pending',
      result: null,
      runningHeadline: null,
      startedAt: Date.now(),
      terminalAt: null,
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
