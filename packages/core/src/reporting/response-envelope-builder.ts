import type { TerminalStatus, WorkerStatus } from './terminal-status-deriver.js';

export interface TaskResponseEnvelope {
  taskId: string;
  tool: string;
  terminalStatus: TerminalStatus;
  workerStatus: WorkerStatus;
  errorCode: string | null;
  headline: string;
  durationMs: number;
  cost?: { actualUSD: number; deltaUSD: number | null; currency: 'USD' };
  concernCount?: number;
  structuredReport?: unknown;
}

export interface BatchResponseEnvelope {
  taskId: string;
  batchCost: { actualUSD: number; deltaUSD: number | null; currency: 'USD'; tasksCount: number };
  tasks: TaskResponseEnvelope[];
}

export class ResponseEnvelopeBuilder {
  buildTask(input: TaskResponseEnvelope): TaskResponseEnvelope {
    return input;
  }

  buildBatch(taskId: string, tasks: TaskResponseEnvelope[]): BatchResponseEnvelope {
    let actual = 0;
    let delta: number | null = 0;
    for (const t of tasks) {
      if (t.cost) {
        actual += t.cost.actualUSD;
        if (t.cost.deltaUSD === null || delta === null) {
          delta = null;
        } else {
          delta += t.cost.deltaUSD;
        }
      }
    }
    return {
      taskId,
      batchCost: { actualUSD: actual, deltaUSD: delta, currency: 'USD', tasksCount: tasks.length },
      tasks,
    };
  }
}
