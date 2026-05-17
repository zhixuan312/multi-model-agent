import type { InvestigationParseResult } from './report-parser-slots/investigate-report.js';

export type IncompleteReason = 'turn_cap' | 'timeout' | 'missing_sections';
export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked';

export interface DeriveInput {
  workerError?: Error;
  incompleteReason?: IncompleteReason;
  needsContext: boolean;
  parseResult: InvestigationParseResult;
}

export interface DeriveOutput {
  workerStatus: WorkerStatus;
  incompleteReason?: IncompleteReason;
}

export function deriveInvestigateWorkerStatus(input: DeriveInput): DeriveOutput {
  if (input.needsContext) return { workerStatus: 'needs_context' };
  if (input.workerError) return { workerStatus: 'blocked' };
  if (input.parseResult.kind === 'no_structured_report') return { workerStatus: 'blocked' };

  const sv = input.parseResult.sectionValidity;
  const sectionsBad =
    sv.summary !== 'valid' ||
    sv.citations === 'empty_invalid' || sv.citations === 'missing' ||
    sv.confidence !== 'valid';

  if (sectionsBad) {
    return {
      workerStatus: 'done_with_concerns',
      incompleteReason: input.incompleteReason ?? 'missing_sections',
    };
  }
  if (input.incompleteReason) {
    return { workerStatus: 'done_with_concerns', incompleteReason: input.incompleteReason };
  }
  return { workerStatus: 'done' };
}
