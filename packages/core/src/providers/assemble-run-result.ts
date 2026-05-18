// v4.4 helper. Build mma's public RuntimeRunResult shape from one SDK turn block
// (TurnResult) plus optional per-stage parsed-report fields. Lifecycle
// handlers call this once per `session.send()`.
//
// The RuntimeRunResult shape preserves every field downstream code expects (50+).
// This helper populates the machine-readable subset (output, usage, files,
// tool counts, cost, termination) and merges in the parser-supplied subset
// when the handler has it. Optional fields not relevant to a given stage
// remain `undefined`.

import type { TurnResult, RuntimeRunResult, TokenUsage } from '../types/run-result.js';

/** Per-stage parsed-report fields the handler may supply. All optional;
 *  handlers that don't parse (e.g. task-executor.ts) pass `{}` or nothing. */
export interface ParsedReportFields {
  reviewVerdict?: 'approved' | 'changes_required';
  reviewFindings?: Array<{ source: 'spec' | 'quality'; text: string }>;
  specReviewerNotes?: string;
  qualityReviewerNotes?: string;
  reworkOutput?: string;
  reworkApplied?: boolean;
  verifyResult?: NonNullable<RuntimeRunResult['verifyResult']>;
}

export function assembleRunResult(
  turn: TurnResult,
  parsed: ParsedReportFields = {},
): RuntimeRunResult {
  const status = mapStatus(turn.terminationReason);
  const tr = turn.terminationReason;
  const mapsToCause = tr === 'ok' || tr === 'cap_exhausted' || tr === 'stalled';
  const terminationReason = mapsToCause
    ? undefined
    : (mapTermination(tr) as RuntimeRunResult['terminationReason']);

  return {
    output: turn.output,
    status,
    usage: turn.usage as TokenUsage,
    actualCostUSD: turn.costUSD,
    turns: turn.turns,
    filesWritten: turn.filesWritten,
    usedShell: turn.usedShell,
    escalationLog: [],
    durationMs: turn.durationMs,
    directoriesListed: [],
    ...(terminationReason && { terminationReason }),
    ...(turn.errorCode && { errorCode: turn.errorCode }),
    ...parsed,
  } as unknown as RuntimeRunResult;
}

function mapStatus(r: string): RuntimeRunResult['status'] {
  switch (r) {
    case 'ok': return 'ok';
    case 'time_exceeded': return 'timeout';
    case 'cap_exhausted': return 'incomplete';
    case 'stalled': return 'incomplete';
    case 'aborted': return 'error';
    case 'error': return 'error';
    default: return 'error';
  }
}

function mapTermination(r: string): string | undefined {
  switch (r) {
    case 'time_exceeded': return 'time_ceiling';
    case 'aborted': return 'all_tiers_unavailable';
    case 'error': return 'all_tiers_unavailable';
    default: return undefined;
  }
}
