// v4.4 helper. Build mma's public RunResult shape from one SDK turn block
// (TurnResult) plus optional per-stage parsed-report fields. Lifecycle
// handlers call this once per `session.send()`.
//
// The RunResult shape preserves every field downstream code expects (50+).
// This helper populates the machine-readable subset (output, usage, files,
// tool counts, cost, termination) and merges in the parser-supplied subset
// when the handler has it. Optional fields not relevant to a given stage
// remain `undefined`.

import type { TurnResult, RunResult, TokenUsage } from '../types/run-result.js';

/** Per-stage parsed-report fields the handler may supply. All optional;
 *  handlers that don't parse (e.g. task-executor.ts) pass `{}` or nothing. */
export interface ParsedReportFields {
  reviewVerdict?: 'approved' | 'changes_required';
  reviewFindings?: Array<{ source: 'spec' | 'quality'; text: string }>;
  specReviewerNotes?: string;
  qualityReviewerNotes?: string;
  reworkOutput?: string;
  reworkApplied?: boolean;
  completionAnnotation?: NonNullable<RunResult['completionAnnotation']>;
  commitGatePercent?: number;
  verifyResult?: NonNullable<RunResult['verifyResult']>;
}

export function assembleRunResult(
  turn: TurnResult,
  parsed: ParsedReportFields = {},
): RunResult {
  const status = mapStatus(turn.terminationReason, turn.errorCode);

  // RunResult.toolCalls is a string[] per the current shape (each entry like
  // "toolName(<input-preview>)"). With v4.4 dropping per-call detail, we
  // synthesize one entry per toolCallsByName count.
  const toolCalls: string[] = [];
  for (const [name, count] of Object.entries(turn.toolCallsByName)) {
    for (let i = 0; i < count; i++) toolCalls.push(name);
  }

  const workerStatus: RunResult['workerStatus'] | undefined =
    turn.workerSelfAssessment ?? (turn.terminationReason === 'ok' ? 'done' : undefined);

  return {
    output: turn.output,
    status,
    usage: turn.usage as TokenUsage,
    actualCostUSD: turn.costUSD,
    turns: turn.turns,
    filesRead: turn.filesRead,
    filesWritten: turn.filesWritten,
    toolCalls,
    outputIsDiagnostic: turn.outputIsDiagnostic ?? false,
    escalationLog: [],
    durationMs: turn.durationMs,
    directoriesListed: [],
    ...(workerStatus && { workerStatus }),
    ...(turn.terminationReason !== 'ok' && { terminationReason: mapTermination(turn.terminationReason) }),
    ...(turn.errorCode && { errorCode: turn.errorCode }),
    ...(turn.errorMessage && { error: turn.errorMessage }),
    ...parsed,
  } as unknown as RunResult;
}

function mapStatus(r: TurnResult['terminationReason'], errorCode?: string): RunResult['status'] {
  switch (r) {
    case 'ok': return 'ok';
    case 'cost_exceeded': return 'cost_exceeded';
    case 'time_exceeded': return 'timeout';
    case 'cap_exhausted': return 'incomplete';
    case 'stalled': return 'incomplete';
    case 'aborted': return 'error';
    case 'error':
      // Preserve transient error subtypes so delegateWithEscalation's retry
      // policy (api_error / provider_transport_failure) can still operate.
      if (errorCode === 'api_error' || errorCode === 'provider_transport_failure') {
        return errorCode as RunResult['status'];
      }
      return 'error';
  }
}

function mapIncompleteReason(r: TurnResult['terminationReason']): RunResult['incompleteReason'] | undefined {
  if (r === 'cap_exhausted') return 'turn_cap';
  if (r === 'stalled') return 'timeout';
  return undefined;
}

function mapTermination(r: TurnResult['terminationReason']): RunResult['terminationReason'] {
  switch (r) {
    case 'ok': return undefined as never;
    case 'time_exceeded': return 'time_ceiling';
    case 'cost_exceeded': return 'cost_ceiling';
    case 'cap_exhausted': return undefined as never;
    case 'stalled': return undefined as never;
    case 'aborted': return 'all_tiers_unavailable';
    case 'error': return 'all_tiers_unavailable';
  }
}
