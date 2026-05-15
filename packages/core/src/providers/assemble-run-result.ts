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

  // Map SDK termination reason; derived once to avoid recomputation.
  const tr = turn.terminationReason;
  const mapsToCause = tr === 'ok' || tr === 'cap_exhausted' || tr === 'stalled';
  const terminationReason = mapsToCause
    ? undefined
    : (mapTermination(tr) as RunResult['terminationReason']);

  const workerStatus: RunResult['workerStatus'] | undefined =
    turn.workerSelfAssessment
      ? (turn.workerSelfAssessment as 'done' | 'failed')
      : (tr === 'ok' ? 'done' : undefined);

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
    ...(workerStatus && { workerStatus: workerStatus as 'done' | 'failed' }),
    ...(terminationReason && { terminationReason }),
    ...(turn.errorCode && { errorCode: turn.errorCode }),
    ...(turn.errorMessage && { error: turn.errorMessage }),
    ...parsed,
  } as unknown as RunResult;
}

function mapStatus(r: string, errorCode?: string): RunResult['status'] {
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
    default:
      // Unknown SDK termination reasons: degrade gracefully to 'error'.
      // This is the safe choice — the run is non-ok, and error is the
      // catch-all that lifecycle handlers inspect.
      return 'error';
  }
}

function mapIncompleteReason(r: string): RunResult['incompleteReason'] | undefined {
  if (r === 'cap_exhausted') return 'turn_cap';
  if (r === 'stalled') return 'timeout';
  return undefined;
}

function mapTermination(r: string): string | undefined {
  switch (r) {
    case 'time_exceeded': return 'time_ceiling';
    case 'cost_exceeded': return 'cost_ceiling';
    case 'aborted': return 'all_tiers_unavailable';
    case 'error': return 'all_tiers_unavailable';
    default: return undefined;
  }
}
