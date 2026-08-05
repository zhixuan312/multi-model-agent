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

/**
 * Which task this panel is showing — `spec`, `review`, `investigate`, `audit (plan)`.
 *
 * The panel used to open with `Running / Phase: implementing`, which is the same two
 * words for every one of the twelve task types. With several panels on screen the only
 * thing telling them apart was an 8-char hex ref. `taskType` is present on every mode,
 * including terminal, where the envelope has always carried `task.type` and the panel
 * has always ignored it.
 */
interface TaskLabel {
  taskType?: string;
  /** Short task id, surfaced so a panel can be correlated with the daemon log and store. */
  taskRef?: string;
}

interface RunningDisplayState extends TaskLabel {
  mode: 'running';
  phase: string;
  elapsedMs: number;
  phaseElapsedMs: number;
  runningHeadline?: string;
  totalTasks?: number;
}

interface CancellingDisplayState extends TaskLabel {
  mode: 'cancelling';
  phase: string;
  elapsedMs: number;
  phaseElapsedMs: number;
}

/**
 * What a finished run cost. Deliberately NO result text: the conversation already carries the
 * full answer immediately below this panel, so repeating a truncated copy is both redundant and
 * misleading about the panel's job — which is to answer "was that worth it?", not "what did it
 * say?". Every field is independently optional; error envelopes null most of them out.
 */
interface TerminalDisplayState extends TaskLabel {
  mode: 'terminal';
  status: string;
  totalDurationMs?: number;
  totalCostUsd?: number;
  savedVsMainCostUsd?: number;
  implementer?: StageStat;
  reviewer?: StageStat;
  /** Input-side tokens split so cache reads are never silently folded into a headline total. */
  tokensIn?: number;
  tokensCached?: number;
  tokensOut?: number;
  filesChanged?: number;
}

interface StageStat {
  durationMs?: number;
  costUsd?: number;
}

export type DisplayState = RunningDisplayState | CancellingDisplayState | TerminalDisplayState;

interface RunningSnapshotLike {
  taskId?: unknown;
  type?: unknown;
  subtype?: unknown;
  status?: unknown;
  phase?: unknown;
  elapsedMs?: unknown;
  phaseElapsedMs?: unknown;
  runningHeadline?: unknown;
  totalTasks?: unknown;
  cancellationRequested?: unknown;
}

interface StageLike { durationMs?: unknown; costUsd?: unknown }

interface TerminalEnvelopeLike {
  task?: { taskId?: unknown; type?: unknown; subtype?: unknown; status?: unknown };
  metrics?: {
    totalDurationMs?: unknown;
    totalCostUsd?: unknown;
    savedVsMainCostUsd?: unknown;
    implementer?: StageLike | null;
    reviewer?: StageLike | null;
    totalUsage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cachedReadTokens?: unknown;
      cachedNonReadTokens?: unknown;
    } | null;
  };
  output?: { summary?: unknown; filesChanged?: unknown };
}

/**
 * A payload is terminal when it carries a `task` object (the terminal envelope shape),
 * as opposed to a running/cancelling snapshot which carries a top-level `status` alongside
 * `taskId`/`phase`.
 */
function isTerminalPayload(payload: unknown): payload is TerminalEnvelopeLike {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'task' in payload &&
    typeof (payload as TerminalEnvelopeLike).task === 'object' &&
    (payload as TerminalEnvelopeLike).task !== null
  );
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `audit` is rendered as `audit (plan)` — the criteria set is the difference between
 * auditing a plan and auditing a spec, and both are dispatched constantly. Every other
 * type has no subtype and renders as itself.
 */
function label(type: unknown, subtype: unknown): string | undefined {
  if (typeof type !== 'string' || !type) return undefined;
  return typeof subtype === 'string' && subtype ? `${type} (${subtype})` : type;
}

function shortRef(taskId: unknown): string | undefined {
  return typeof taskId === 'string' ? taskId.slice(0, 8) : undefined;
}

function stage(raw: StageLike | null | undefined): StageStat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const durationMs = num(raw.durationMs);
  const costUsd = num(raw.costUsd);
  if (durationMs === undefined && costUsd === undefined) return undefined;
  return { ...(durationMs !== undefined && { durationMs }), ...(costUsd !== undefined && { costUsd }) };
}

function deriveTerminal(payload: TerminalEnvelopeLike): TerminalDisplayState {
  const taskType = label(payload.task?.type, payload.task?.subtype);
  const taskRef = shortRef(payload.task?.taskId);
  const state: TerminalDisplayState = {
    mode: 'terminal',
    status: String(payload.task?.status ?? ''),
    ...(taskType ? { taskType } : {}),
    ...(taskRef ? { taskRef } : {}),
  };
  const m = payload.metrics;
  if (m) {
    const assign = <K extends keyof TerminalDisplayState>(key: K, value: TerminalDisplayState[K]) => {
      if (value !== undefined) state[key] = value;
    };
    assign('totalDurationMs', num(m.totalDurationMs));
    assign('totalCostUsd', num(m.totalCostUsd));
    assign('savedVsMainCostUsd', num(m.savedVsMainCostUsd));
    assign('implementer', stage(m.implementer));
    assign('reviewer', stage(m.reviewer));

    const u = m.totalUsage;
    if (u) {
      // Cache reads are reported separately from fresh input on purpose. A single "3.2M
      // tokens" headline would be dominated by cache — 2.86M of 3.09M on a real run — and
      // would read as enormous usage when it is mostly the cheap path.
      assign('tokensIn', num(u.inputTokens));
      assign('tokensOut', num(u.outputTokens));
      const cached = (num(u.cachedReadTokens) ?? 0) + (num(u.cachedNonReadTokens) ?? 0);
      if (cached > 0) state.tokensCached = cached;
    }
  }
  if (Array.isArray(payload.output?.filesChanged) && payload.output.filesChanged.length > 0) {
    state.filesChanged = payload.output.filesChanged.length;
  }
  return state;
}

function deriveRunningOrCancelling(
  payload: RunningSnapshotLike
): RunningDisplayState | CancellingDisplayState {
  const phase = String(payload.phase ?? '');
  const elapsedMs = typeof payload.elapsedMs === 'number' ? payload.elapsedMs : 0;
  const phaseElapsedMs = typeof payload.phaseElapsedMs === 'number' ? payload.phaseElapsedMs : 0;

  const taskRef = shortRef(payload.taskId);
  const taskType = label(payload.type, payload.subtype);

  if (payload.cancellationRequested === true) {
    return {
      mode: 'cancelling', phase, elapsedMs, phaseElapsedMs,
      ...(taskType ? { taskType } : {}),
      ...(taskRef ? { taskRef } : {}),
    };
  }

  const state: RunningDisplayState = { mode: 'running', phase, elapsedMs, phaseElapsedMs };
  if (taskType) state.taskType = taskType;
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
