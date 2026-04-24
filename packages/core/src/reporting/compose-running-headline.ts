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

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export function composeRunningHeadline(s: RunningState): string {
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
