// merge-stage-stats.ts
//
// Helper that mutates state.lastRunResult.stageStats[<stage>] to record
// per-stage execution costs as each stage handler completes. Without this,
// only the implementer's RuntimeRunResult.usage is visible at terminal — the
// reviewer / annotator / rework / diff / verify costs are dropped on the
// floor. Affected events:
//   - local `task_completed` (top-level inputTokens / outputTokens / cost)
//   - wire `task.completed` (per-stage `stages[]` array + tier rollup)
//
// Stages with multi-round semantics (spec_review, quality_review) accumulate
// across rounds; the schema has one slot per stage name with `roundsUsed`
// reflecting the total number of rounds executed.

import type { LifecycleState } from './stage-plan-types.js';
import type { RuntimeRunResult } from '../types.js';

export type StageName =
  | 'implementing'
  | 'review'
  | 'rework'
  | 'annotating'
  | 'committing';

interface StageDelta {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedNonReadTokens?: number;
  turnCount: number;
  toolCallCount: number;
  costUSD: number | null;
  durationMs: number | null;
  filesReadCount?: number;
  filesWrittenCount?: number;
}

interface StageOptions {
  tier: 'standard' | 'complex' | null;
  model: string | null;
  modelFamily?: string | null;
  /** For the `review` stage — combined verdict from parallel spec+quality sub-reviewers. */
  verdict?: string;
  /** Defaults to +1 per call so the wire's `roundsUsed` reflects rounds taken. */
  roundsDelta?: number;
}

/**
 * Merge a stage's per-call cost into state.lastRunResult.stageStats.
 * Multi-round stages accumulate; single-shot stages overwrite.
 */
export function mergeStageStats(
  state: LifecycleState,
  stage: StageName,
  delta: StageDelta,
  options: StageOptions,
): void {
  const rr = state.lastRunResult as RuntimeRunResult | undefined;
  if (!rr) return;
  const existing = ((rr.stageStats ?? {}) as Record<string, Record<string, unknown> | undefined>)[stage];

  const accumulated = {
    stage,
    entered: true,
    durationMs: ((existing?.['durationMs'] as number | null | undefined) ?? 0) + (delta.durationMs ?? 0),
    costUSD: combineCost(existing?.['costUSD'] as number | null | undefined, delta.costUSD),
    agentTier: options.tier ?? (existing?.['agentTier'] as 'standard' | 'complex' | null | undefined) ?? null,
    modelFamily: options.modelFamily ?? (existing?.['modelFamily'] as string | null | undefined) ?? null,
    model: options.model ?? (existing?.['model'] as string | null | undefined) ?? null,
    maxIdleMs: 0,
    totalIdleMs: 0,
    activityEvents: 0,
    inputTokens: ((existing?.['inputTokens'] as number | null | undefined) ?? 0) + delta.inputTokens,
    outputTokens: ((existing?.['outputTokens'] as number | null | undefined) ?? 0) + delta.outputTokens,
    cachedReadTokens: ((existing?.['cachedReadTokens'] as number | null | undefined) ?? 0) + (delta.cachedReadTokens ?? 0),
    cachedNonReadTokens: ((existing?.['cachedNonReadTokens'] as number | null | undefined) ?? 0) + (delta.cachedNonReadTokens ?? 0),
    turnCount: ((existing?.['turnCount'] as number | null | undefined) ?? 0) + delta.turnCount,
    toolCallCount: ((existing?.['toolCallCount'] as number | null | undefined) ?? 0) + delta.toolCallCount,
    filesReadCount: ((existing?.['filesReadCount'] as number | null | undefined) ?? 0) + (delta.filesReadCount ?? 0),
    filesWrittenCount: ((existing?.['filesWrittenCount'] as number | null | undefined) ?? 0) + (delta.filesWrittenCount ?? 0),
  } as Record<string, unknown>;

  if (stage === 'review') {
    accumulated['verdict'] = options.verdict ?? existing?.['verdict'] ?? null;
    accumulated['roundsUsed'] = ((existing?.['roundsUsed'] as number | undefined) ?? 0) + (options.roundsDelta ?? 1);
    accumulated['concernCategories'] = existing?.['concernCategories'] ?? [];
    accumulated['findingsBySeverity'] = existing?.['findingsBySeverity'] ?? { critical: 0, high: 0, medium: 0, low: 0 };
  } else if (stage === 'rework') {
    accumulated['triggeringConcernCategories'] = existing?.['triggeringConcernCategories'] ?? [];
  }

  const stageStatsObj = (rr.stageStats ?? {}) as Record<string, unknown>;
  stageStatsObj[stage] = accumulated;
  (rr as { stageStats?: unknown }).stageStats = stageStatsObj;
}

/** Sum nullable cost slots; null when both contributions are null (honest-null). */
function combineCost(a: number | null | undefined, b: number | null): number | null {
  if (a === null || a === undefined) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * Replace state.lastRunResult with the rework-stage's `newResult`, but
 * preserve cumulative file-tracker arrays AND stageStats from the prior
 * lastRunResult.
 *
 * Tool sweep #6 fix: the spec-chain and quality-chain handlers both
 * replaced `state.lastRunResult` with the rework's RuntimeRunResult, only
 * keeping `stageStats`. Implementing-stage file writes were thereby
 * lost when a spec-rework round produced no writes:
 *   implementer:   filesWritten=['/x.ts']  ← real edit applied
 *   spec_review:   no run
 *   spec_rework:   filesWritten=[]         ← reads but no writes
 * Envelope read `lastRunResult.filesWritten` → `[]`, downstream
 * `qualityReviewStatus` collapsed to "task produced no file artifacts
 * to review" and the headline reported "(0 files)" even though the
 * implementer had successfully made the requested edit.
 *
 * Stage stats already tracked the writes correctly per-stage (the wire
 * telemetry's `findings_low` etc. are computed from stageStats). Only
 * the result envelope's `filesRead` / `filesWritten` / `toolCalls`
 * arrays were broken.
 *
 * Fix: union the arrays across all rework rounds. Stable de-dupe via
 * Set so a file edited twice doesn't appear twice in the envelope.
 */
export function replaceLastRunResultPreservingTrackers(
  state: LifecycleState,
  newResult: RuntimeRunResult,
): void {
  const prior = state.lastRunResult as RuntimeRunResult | undefined;
  if (!prior) {
    state.lastRunResult = newResult;
    return;
  }
  const unionStrings = (
    a: ReadonlyArray<string> | undefined,
    b: ReadonlyArray<string> | undefined,
  ): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of a ?? []) {
      if (typeof x === 'string' && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    for (const x of b ?? []) {
      if (typeof x === 'string' && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    return out;
  };
  state.lastRunResult = {
    ...newResult,
    stageStats: prior.stageStats ?? newResult.stageStats,
    filesRead: unionStrings(prior.filesRead, newResult.filesRead),
    filesWritten: unionStrings(prior.filesWritten, newResult.filesWritten),
    toolCalls: [...(prior.toolCalls ?? []), ...(newResult.toolCalls ?? [])],
  };
}
