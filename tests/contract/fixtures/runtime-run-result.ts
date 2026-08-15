// Test-only "fat" run-result shape for the contract mock providers.
//
// Production runners produce PipelineResult (two-phase-pipeline.ts) from
// TurnResult / Session / Provider; the terminal TaskEnvelope is assembled by
// buildEnvelopeSnapshot(). RuntimeRunResult is a broader convenience shape the
// mock providers populate to drive the pipeline and the wire/envelope builders in
// contract tests. It has no production caller, so it lives under tests/.

import type { TokenUsage } from '../../../packages/core/src/types/run-result.js';

/**
 * Statuses a mock provider can report for one escalation attempt.
 *
 * This and `EscalationRecord` below were `RunStatus` and `AttemptRecord` in
 * `packages/core/src/providers/runner-types.ts` — exported from the published core barrel,
 * referenced by no production code, and imported only by this fixture, which ALSO declared its
 * own structurally-identical `EscalationRecord`. Test scaffolding shipped to npm consumers as
 * public API, in two copies. `status` is typed here rather than left as `string`, which is what
 * the two copies actually disagreed about.
 */
export type RunStatus =
  | 'ok'
  | 'incomplete'
  | 'timeout'
  | 'error'
  | 'brief_too_vague'
  | 'unavailable';

/** Cause values for the TerminationReason object. */
export type _TerminationCause =
  | 'finished'
  | 'incomplete'
  | 'timeout'
  | 'time_ceiling'
  | 'degenerate_exhausted'
  | 'brief_too_vague'
  | 'error';

export interface EscalationRecord {
  provider: string;
  status: RunStatus;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
  initialPromptLengthChars: number;
  initialPromptHash: string;
  reason?: string;
}

export interface RuntimeRunResult {
  output: string;
  status: string;
  usage: TokenUsage;
  actualCostUSD: number;
  turns: number;
  filesWritten: string[];
  workerStatus?: 'done' | 'failed' | 'blocked';
  terminationReason?: { cause: _TerminationCause; turnsUsed: number; hasFileArtifacts: boolean; usedShell: boolean; workerSelfAssessment: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_capped' | null; wasPromoted: boolean; wallClockMs?: number };
  usedShell?: boolean;
  errorCode?: string;
  error?: string;
  escalationLog: EscalationRecord[];
  durationMs?: number;
  models?: {
    implementer?: string;
    reviewer?: string;
    [key: string]: string | undefined;
  };
  agents?: {
    implementer?: string;
    [key: string]: unknown;
  };
  stallCount?: number;
  taskMaxIdleMs?: number;
  structuredError?: { code: string; message: string; where?: string };
  cost?: { costUSD: number | null; costDeltaVsMainUSD: number | null };
}
