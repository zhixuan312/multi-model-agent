import type { WorkerStatus, ErrorCode } from '../types.js';

export interface CallerEnvelope {
  taskIndex: number;
  workerStatus: WorkerStatus;
  summary?: string;
  filesChanged?: string[];
  blockId?: string;
  errorCode?: ErrorCode;
  costUSD?: number;
  durationMs?: number;
}

export class CallerResponseChannel {
  private snapshots = new Map<number, CallerEnvelope>();

  upsert(env: CallerEnvelope): void {
    this.snapshots.set(env.taskIndex, env);
  }

  snapshot(): CallerEnvelope[] {
    return [...this.snapshots.values()].sort((a, b) => a.taskIndex - b.taskIndex);
  }
}
