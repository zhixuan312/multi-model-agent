/**
 * Pure, DOM-free display-state derivation for the execution-monitor MCP App.
 *
 * `deriveDisplayState` maps a parsed poll/initiating payload (a `RunningSnapshot`-shaped
 * object or a terminal envelope) onto exactly one of three render modes. It performs no
 * I/O, touches no globals, and is safe to unit-test in the default (node) Vitest
 * environment — the bootstrap in `entry.ts` is the only DOM-touching layer, and it wraps
 * this function's output with connection/poll-failure states of its own
 * (`connecting`, `connection-error`, `stopped`).
 */

export interface RunningDisplayState {
  mode: 'running';
  /** Short task id, surfaced so a panel can be correlated with the daemon log and store. */
  taskRef?: string;
  phase: string;
  elapsedMs: number;
  phaseElapsedMs: number;
  runningHeadline?: string;
  totalTasks?: number;
}

export interface CancellingDisplayState {
  mode: 'cancelling';
  taskRef?: string;
  phase: string;
  elapsedMs: number;
  phaseElapsedMs: number;
}

export interface TerminalDisplayState {
  mode: 'terminal';
  status: string;
  totalCostUsd?: number;
  savedVsMainCostUsd?: number;
  summary?: unknown;
}

export type DisplayState = RunningDisplayState | CancellingDisplayState | TerminalDisplayState;

interface RunningSnapshotLike {
  taskId?: unknown;
  status?: unknown;
  phase?: unknown;
  elapsedMs?: unknown;
  phaseElapsedMs?: unknown;
  runningHeadline?: unknown;
  totalTasks?: unknown;
  cancellationRequested?: unknown;
}

interface TerminalEnvelopeLike {
  task?: { taskId?: unknown; status?: unknown };
  metrics?: { totalCostUsd?: unknown; savedVsMainCostUsd?: unknown };
  output?: { summary?: unknown };
}

/**
 * A payload is terminal when it carries a `task` object (the terminal envelope shape),
 * as opposed to a running/cancelling snapshot which carries a top-level `status` alongside
 * `taskId`/`phase`.
 */
export function isTerminalPayload(payload: unknown): payload is TerminalEnvelopeLike {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'task' in payload &&
    typeof (payload as TerminalEnvelopeLike).task === 'object' &&
    (payload as TerminalEnvelopeLike).task !== null
  );
}

function deriveTerminal(payload: TerminalEnvelopeLike): TerminalDisplayState {
  const state: TerminalDisplayState = {
    mode: 'terminal',
    status: String(payload.task?.status ?? ''),
  };
  if (payload.metrics && typeof payload.metrics.totalCostUsd === 'number') {
    state.totalCostUsd = payload.metrics.totalCostUsd;
  }
  if (payload.metrics && typeof payload.metrics.savedVsMainCostUsd === 'number') {
    state.savedVsMainCostUsd = payload.metrics.savedVsMainCostUsd;
  }
  if (payload.output && 'summary' in payload.output) {
    state.summary = payload.output.summary;
  }
  return state;
}

function deriveRunningOrCancelling(
  payload: RunningSnapshotLike
): RunningDisplayState | CancellingDisplayState {
  const phase = String(payload.phase ?? '');
  const elapsedMs = typeof payload.elapsedMs === 'number' ? payload.elapsedMs : 0;
  const phaseElapsedMs = typeof payload.phaseElapsedMs === 'number' ? payload.phaseElapsedMs : 0;

  const taskRef = typeof payload.taskId === 'string' ? payload.taskId.slice(0, 8) : undefined;

  if (payload.cancellationRequested === true) {
    return { mode: 'cancelling', phase, elapsedMs, phaseElapsedMs, ...(taskRef ? { taskRef } : {}) };
  }

  const state: RunningDisplayState = { mode: 'running', phase, elapsedMs, phaseElapsedMs };
  if (taskRef) state.taskRef = taskRef;
  if (typeof payload.runningHeadline === 'string') {
    state.runningHeadline = payload.runningHeadline;
  }
  if (typeof payload.totalTasks === 'number') {
    state.totalTasks = payload.totalTasks;
  }
  return state;
}

/**
 * Derives the render state for a parsed `mma_run`/`mma_task_get` payload. Throws on a
 * payload that is neither a terminal envelope nor a running/cancelling snapshot — callers
 * (`entry.ts`) catch that and retain the last-known-good state per the update-failed
 * invariant; this function itself stays pure and has no fallback branch of its own.
 */
export function deriveDisplayState(payload: unknown): DisplayState {
  if (isTerminalPayload(payload)) {
    return deriveTerminal(payload);
  }
  if (typeof payload === 'object' && payload !== null) {
    return deriveRunningOrCancelling(payload as RunningSnapshotLike);
  }
  throw new Error('deriveDisplayState: unrecognized payload shape');
}
