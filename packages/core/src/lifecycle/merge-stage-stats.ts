// merge-stage-stats.ts
//
// Helper that mutates state.lastRunResult.stageStats[<stage>] to record
// per-stage execution costs as each stage handler completes. Without this,
// only the implementer's RunResult.usage is visible at terminal — the
// reviewer / annotator / rework / diff / verify costs are dropped on the
// floor. Affected events:
//   - local `task_completed` (top-level inputTokens / outputTokens / cost)
//   - wire `task.completed` (per-stage `stages[]` array + tier rollup)
//
// Stages with multi-round semantics (spec_review, quality_review) accumulate
// across rounds; the schema has one slot per stage name with `roundsUsed`
// reflecting the total number of rounds executed.

import type { LifecycleState } from './stage-plan-types.js';
import type { RunResult } from '../types.js';

export type StageName =
  | 'implementing'
  | 'spec_review'
  | 'spec_rework'
  | 'quality_review'
  | 'quality_rework'
  | 'diff_review'
  | 'verifying'
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
  /** For spec_review / quality_review / diff_review only. */
  verdict?: string;
  /** For spec_review / quality_review / diff_review only — defaults to +1
   *  per call so multi-round chains accumulate naturally. */
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
  const rr = state.lastRunResult as RunResult | undefined;
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

  if (stage === 'spec_review' || stage === 'quality_review' || stage === 'diff_review') {
    accumulated['verdict'] = options.verdict ?? existing?.['verdict'] ?? null;
    accumulated['roundsUsed'] = ((existing?.['roundsUsed'] as number | undefined) ?? 0) + (options.roundsDelta ?? 1);
    accumulated['concernCategories'] = existing?.['concernCategories'] ?? [];
    accumulated['findingsBySeverity'] = existing?.['findingsBySeverity'] ?? { critical: 0, high: 0, medium: 0, low: 0 };
  } else if (stage === 'spec_rework' || stage === 'quality_rework') {
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
