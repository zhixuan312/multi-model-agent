import type {
  ClarificationEntry,
  IntakeProgress,
} from '@zhixuan92/multi-model-agent-core/intake/types';

export interface ClarificationAwareResponseInput {
  batchId: string;
  results: unknown[];
  clarifications: ClarificationEntry[];
  intakeProgress: IntakeProgress;
  clarificationId?: string;
  originalBatchId?: string;
}

export interface ClarificationAwareResponse {
  schemaVersion: string;
  batchId: string;
  results: unknown[];
  clarifications: ClarificationEntry[];
  intakeProgress: IntakeProgress;
  clarificationId?: string;
  originalBatchId?: string;
}

export function computeIntakeProgress(
  readyCount: number,
  clarificationCount: number,
  hardErrorCount: number,
  executedCount: number,
): IntakeProgress {
  return {
    totalDrafts: readyCount + clarificationCount + hardErrorCount,
    readyDrafts: readyCount,
    clarificationDrafts: clarificationCount,
    hardErrorDrafts: hardErrorCount,
    executedDrafts: executedCount,
  };
}

export function buildClarificationAwareResponse(
  input: ClarificationAwareResponseInput,
): ClarificationAwareResponse {
  const response: ClarificationAwareResponse = {
    schemaVersion: '2.1.0',
    batchId: input.batchId,
    results: input.results,
    clarifications: input.clarifications,
    intakeProgress: input.intakeProgress,
  };

  if (input.clarificationId) {
    response.clarificationId = input.clarificationId;
  }
  if (input.originalBatchId) {
    response.originalBatchId = input.originalBatchId;
  }

  return response;
}