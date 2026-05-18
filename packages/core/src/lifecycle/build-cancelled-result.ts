import type { RuntimeRunResult } from '../types/run-result.js';

/**
 * Builds a cancelled-not-started result envelope. Used by the grouped
 * dispatcher to fill slots for tasks that never began because the batch
 * was aborted mid-group. Reuses workerStatus 'failed' to preserve the
 * existing WorkerStatus enum and asyncDispatch.detectFailure logic; the
 * 'cancelled' errorCode is the distinguishing field for consumers that
 * care.
 */
export function buildCancelledResult(): RuntimeRunResult {
  return {
    output: '',
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    turns: 0,
    filesWritten: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    durationMs: 0,
    workerStatus: 'failed',
    errorCode: 'cancelled',
    actualCostUSD: 0,
    directoriesListed: [],
  } as RuntimeRunResult;
}
