export interface DeriveStatusInput {
  workerError: Error | undefined;
  incompleteReason: 'turn_cap' | 'cost_cap' | 'timeout' | undefined;
  parseDiagnostics: { malformed: boolean; insufficientThreads: boolean; droppedThreads: string[] };
  threads: number;
}

export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed';
export type IncompleteReason =
  | 'turn_cap' | 'cost_cap' | 'timeout'
  | 'malformed_threads'
  | 'threads_dropped'
  | 'insufficient_threads'
  | 'missing_internal_input' | 'missing_external_input' | 'no_input_available';

export interface DeriveStatusOutput {
  workerStatus: WorkerStatus;
  incompleteReason?: IncompleteReason;
}

export function deriveExploreStatus(input: DeriveStatusInput): DeriveStatusOutput {
  if (input.workerError) return { workerStatus: 'failed' };
  if (input.incompleteReason !== undefined) return { workerStatus: 'done_with_concerns', incompleteReason: input.incompleteReason };
  if (input.parseDiagnostics.malformed) return { workerStatus: 'done_with_concerns', incompleteReason: 'malformed_threads' };
  if (input.parseDiagnostics.insufficientThreads) return { workerStatus: 'done_with_concerns', incompleteReason: 'insufficient_threads' };
  if (input.parseDiagnostics.droppedThreads.length > 0) {
    return { workerStatus: 'done_with_concerns', incompleteReason: 'threads_dropped' };
  }
  return { workerStatus: 'done' };
}
