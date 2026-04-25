import type { InvestigationParseResult } from './parse-investigation-report.js';

export type CapKind = 'turn' | 'cost' | 'wall_clock';
export type IncompleteReason = 'turn_cap' | 'cost_cap' | 'timeout' | 'missing_sections';
export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked';

export function mapCapToReason(cap: CapKind): IncompleteReason {
  switch (cap) {
    case 'turn': return 'turn_cap';
    case 'cost': return 'cost_cap';
    case 'wall_clock': return 'timeout';
  }
}

export interface DeriveInput {
  workerError?: Error;
  capExhausted?: CapKind;
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
      incompleteReason: input.capExhausted ? mapCapToReason(input.capExhausted) : 'missing_sections',
    };
  }
  if (input.capExhausted) {
    return { workerStatus: 'done_with_concerns', incompleteReason: mapCapToReason(input.capExhausted) };
  }
  return { workerStatus: 'done' };
}
