export interface RunningTask {
  worker: string;
  turn: number;
}

export interface RunningState {
  tasksTotal: number;
  tasksStarted: number;
  tasksCompleted: number;
  startedAt: number;
  nowMs: number;
  lastHeartbeatAt: number;
  running: RunningTask[];
  heartbeatIntervalMs?: number;
}

interface RunningTaskProgress {
  state: 'implementing' | 'reviewing' | 'done' | 'error' | string;
  stageInfo?: string;
  filesRead?: number;
  filesWritten?: number;
  toolCalls?: number;
  errorMessage?: string;
  files?: string[];
}

interface RunningHeadlineBatchState {
  tasks: RunningTaskProgress[];
  elapsedMs: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

function formatElapsedFromMs(ms: number): string {
  const elapsedS = Math.max(0, Math.floor(ms / 1000));
  const elapsedM = Math.floor(elapsedS / 60);
  const sec = elapsedS % 60;
  return `${elapsedM}m ${sec}s`;
}

function formatLegacyHeadline(s: RunningState): string {
  const tasksTotal = Math.max(0, s.tasksTotal);
  const tasksStarted = Math.min(tasksTotal, Math.max(0, s.tasksStarted));
  const tasksCompleted = Math.min(tasksStarted, Math.max(0, s.tasksCompleted));
  const elapsedS = Math.max(0, Math.floor((s.nowMs - s.startedAt) / 1000));
  const hbInterval = s.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const stallThresholdMs = 2 * hbInterval;
  const sinceHeartbeatMs = s.lastHeartbeatAt > 0 ? Math.max(0, s.nowMs - s.lastHeartbeatAt) : 0;
  const stalled = s.lastHeartbeatAt > 0 && sinceHeartbeatMs > stallThresholdMs;
  const stallStr = stalled ? ` (stalled: no heartbeat for ${Math.floor(sinceHeartbeatMs / 1000)}s)` : '';

  if (tasksTotal === 0) {
    return `no tasks, ${elapsedS}s elapsed`;
  }

  if (tasksTotal === 1) {
    if (tasksStarted === 0) {
      return `1/1 queued, ${elapsedS}s elapsed`;
    }
    if (tasksCompleted === 1) {
      return `1/1 complete, ${elapsedS}s elapsed`;
    }
    const w = s.running[0];
    const workerStr = w ? `, worker: ${w.worker} (turn ${w.turn})` : '';
    return `1/1 running, ${elapsedS}s elapsed${stallStr}${workerStr}`;
  }

  const nRunning = Math.max(0, tasksStarted - tasksCompleted);
  return `${tasksCompleted}/${tasksTotal} complete, ${nRunning} running, ${elapsedS}s elapsed${stallStr}`;
}

function capitalizeState(state: string): string {
  if (!state) {
    return '';
  }
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatDoneTaskLine(task: RunningTaskProgress): string {
  const reads = Math.max(0, task.filesRead ?? 0);
  const toolCalls = Math.max(0, task.toolCalls ?? 0);
  const files = Array.isArray(task.files) ? task.files : [];

  if (files.length === 0) {
    return `done — ${reads} read, ${toolCalls} tool calls`;
  }

  const shownFiles = files.slice(0, 3);
  const fileSuffix = files.length > 3 ? `, ... +${files.length - 3} more` : '';
  return `done — ${reads} read, ${toolCalls} tool calls — files: ${shownFiles.join(', ')}${fileSuffix}`;
}

function formatActiveTaskLine(task: RunningTaskProgress): string {
  const verb = capitalizeState(task.state);
  const reads = Math.max(0, task.filesRead ?? 0);
  const writes = Math.max(0, task.filesWritten ?? 0);
  const calls = Math.max(0, task.toolCalls ?? 0);
  const worker = task.stageInfo ?? 'worker';
  return `${verb} by ${worker} - ${reads} read, ${writes} write, ${calls} tool calls`;
}

function formatTaskLine(task: RunningTaskProgress): string {
  if (task.state === 'done') {
    return formatDoneTaskLine(task);
  }
  if (task.state === 'error') {
    return `error: ${task.errorMessage ?? ''}`;
  }
  return formatActiveTaskLine(task);
}

function composeBatchHeadline(state: RunningHeadlineBatchState): string {
  const tasks = state.tasks;
  const elapsedMs = Math.max(0, state.elapsedMs);
  const total = tasks.length;

  if (total === 0) {
    return `no tasks`;
  }

  if (total === 1) {
    const task = tasks[0];
    const elapsed = formatElapsedFromMs(elapsedMs);
    if (task.state === 'done') {
      return `[1/1] ${formatDoneTaskLine(task)}`;
    }
    if (task.state === 'error') {
      return `[1/1] ${formatTaskLine(task)}`;
    }
    const stateLine = formatActiveTaskLine(task);
    return `[1/1] ${stateLine.replace(' - ', ` - ${elapsed}, `)}`;
  }

  const doneCount = tasks.filter((task) => task.state === 'done').length;
  const header = (doneCount > 0)
    ? `[${doneCount}/${total} done] running ${formatElapsedFromMs(elapsedMs)}`
    : `[${total}/${total}] running ${formatElapsedFromMs(elapsedMs)}`;

  const taskLines = tasks.map((task, index) => `  [${index + 1}] ${formatTaskLine(task)}`);
  return [header, ...taskLines].join('\n');
}

function hasBatchShape(state: RunningState | RunningHeadlineBatchState): state is RunningHeadlineBatchState {
  return Array.isArray((state as RunningHeadlineBatchState).tasks);
}

export function composeRunningHeadline(s: RunningState | RunningHeadlineBatchState): string {
  if (hasBatchShape(s)) {
    return composeBatchHeadline(s);
  }
  return formatLegacyHeadline(s);
}
