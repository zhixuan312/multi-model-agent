import type { Input } from './schema.js';

export interface RetryBrief {
  batchId: string;
  taskIndex: number;
}

export const retryBriefSlot = (input: Input): RetryBrief[] =>
  input.taskIndices.map((idx) => ({ batchId: input.batchId, taskIndex: idx }));
