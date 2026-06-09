import type { Input } from './schema.js';

export interface RetryBrief {
  batchId: string;
}

/** One brief: re-fire the stored goal-set for `batchId`. */
export const retryBriefSlot = (input: Input): RetryBrief[] => [{ batchId: input.batchId }];
