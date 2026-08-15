// The shape the contract mock providers build, and the only fields anything reads.
//
// Production runners produce PipelineResult (two-phase-pipeline.ts) from TurnResult / Session /
// Provider; the terminal TaskEnvelope is assembled by buildEnvelopeSnapshot(). This is a
// test-only intermediate: each mock builder returns one of these, and `runResultToTurnResult` in
// mock-providers.ts projects it down to the `TurnResult` the provider contract actually returns.
// It has no production caller, so it lives under tests/.
//
// It used to be a deliberately "fat" shape, and most of the fat was inert. `runResultToTurnResult`
// is its ONLY consumer and reads eleven fields; everything else the builders constructed was
// discarded on the way out:
//
//   - `terminationReason` — a seven-field object (`cause`, `turnsUsed`, `hasFileArtifacts`,
//     `wasPromoted`, `workerSelfAssessment`, …) assembled by every builder and never read. The
//     converter derives the turn's reason from `status` instead. `_TerminationCause` and the
//     `statusToCause` helper existed only to populate it.
//   - `escalationLog` / `EscalationRecord` — likewise built and discarded. The type had already
//     been noted as test scaffolding that shipped to npm consumers as public API in two copies.
//   - `stallCount`, `taskMaxIdleMs` — permanently 0 in production too (see module 25's finding on
//     the wire record); nothing here read them either.
//   - `models`, `agents`, `structuredError` — no reader.
//
// All of it also kept the retired lifecycle vocabulary alive inside the test tree, where the
// packaged-skill vocabulary sweep does not reach: `brief_too_vague`, `needs_context`,
// `review_loop_capped`, `degenerate_exhausted`, `wasPromoted`. Nothing in the engine produces any
// of them, and no test ever set them.
//
// Keep this shape at exactly what the converter consumes. A field here that the converter ignores
// is a field a test can set while believing it changed something.

import type { TokenUsage } from '../../../packages/core/src/types/run-result.js';

/**
 * Statuses a mock run can report.
 *
 * Trimmed to the four `statusToTermination` distinguishes and any test actually sets.
 * `brief_too_vague` and `unavailable` used to sit here; no test ever passed either, and the
 * engine emits neither — they were the retired lifecycle vocabulary, surviving in a fixture.
 */
export type RunStatus = 'ok' | 'incomplete' | 'timeout' | 'error';

export interface RuntimeRunResult {
  output: string;
  status: RunStatus;
  usage: TokenUsage;
  actualCostUSD: number;
  turns: number;
  filesWritten: string[];
  durationMs?: number;
  usedShell?: boolean;
  errorCode?: string;
  error?: string;
  /** Surfaced on the projected TurnResult as `errorMessage`/`errorCode`; see the converter. */
  cost?: { costUSD: number | null };
}
