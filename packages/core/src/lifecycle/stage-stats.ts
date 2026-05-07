// Stage-stats helpers: pure functions that build / mutate the per-task
// StageStatsMap. No closure state captured here — the orchestrator stays
// focused on flow control.
import type { StageStatsMap, ReviewVerdict, VerifyOutcome, VerifySkipReason } from '../types.js';
import { findModelProfile } from '../config/model-profile-registry.js';

export const READ_ONLY_TOOL_NAMES: Set<string> = new Set([
  'audit', 'review', 'verify', 'investigate', 'debug',
]);

const _emptyMetrics = { inputTokens: null, outputTokens: null, cachedReadTokens: null, cachedNonReadTokens: null, turnCount: null, toolCallCount: null, filesReadCount: null, filesWrittenCount: null } as const;

export function emptyStats(): StageStatsMap {
  return {
    implementing:   { stage: 'implementing',   entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    spec_rework:    { stage: 'spec_rework',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    quality_rework: { stage: 'quality_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    committing:     { stage: 'committing',     entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, ..._emptyMetrics },
    verifying:      { stage: 'verifying',      entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, outcome: null, skipReason: null, ..._emptyMetrics },
    spec_review:    { stage: 'spec_review',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, verdict: null, roundsUsed: null, ..._emptyMetrics },
    quality_review: { stage: 'quality_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, verdict: null, roundsUsed: null, ..._emptyMetrics },
    diff_review:    { stage: 'diff_review',    entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0, verdict: null, roundsUsed: null, ..._emptyMetrics },
  };
}

export function modelFamily(model: string): string {
  return findModelProfile(model).family;
}

export function endBaseStage(
  stats: StageStatsMap,
  name: 'implementing' | 'spec_rework' | 'quality_rework' | 'committing',
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
  metrics?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedNonReadTokens?: number; turnCount?: number; toolCallCount?: number; filesReadCount?: number; filesWrittenCount?: number; costUSD?: number },
): void {
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs: Date.now() - t0,
    costUSD: metrics?.costUSD !== undefined ? metrics.costUSD
      : finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: idle?.maxIdleMs ?? 0,
    totalIdleMs: idle?.totalIdleMs ?? 0,
    activityEvents: idle?.activityEvents ?? 0,
    inputTokens: metrics?.inputTokens ?? null,
    outputTokens: metrics?.outputTokens ?? null,
    cachedReadTokens: metrics?.cachedReadTokens ?? null,
    cachedNonReadTokens: metrics?.cachedNonReadTokens ?? null,
    turnCount: metrics?.turnCount ?? null,
    toolCallCount: metrics?.toolCallCount ?? null,
    filesReadCount: metrics?.filesReadCount ?? null,
    filesWrittenCount: metrics?.filesWrittenCount ?? null,
  };
}

export function endReviewStage(
  stats: StageStatsMap,
  name: 'spec_review' | 'quality_review' | 'diff_review',
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
  verdict: ReviewVerdict,
  roundsUsed: number,
  metrics?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedNonReadTokens?: number; turnCount?: number; toolCallCount?: number; filesReadCount?: number; filesWrittenCount?: number; costUSD?: number; durationMs?: number },
): void {
  const durationMs = metrics?.durationMs !== undefined ? metrics.durationMs : Date.now() - t0;
  // Idle-tracker leak guard: tail events from cross-runner async cleanup can
  // land after the stage's wall-clock end, producing totalIdleMs values that
  // exceed durationMs. Clamping prevents impossible values from reaching the
  // dashboard while preserving the legitimate per-stage signal in the common case.
  const rawTotalIdle = idle?.totalIdleMs ?? 0;
  const rawMaxIdle = idle?.maxIdleMs ?? 0;
  const clampedTotalIdle = Math.min(rawTotalIdle, Math.max(0, durationMs));
  const clampedMaxIdle = Math.min(rawMaxIdle, Math.max(0, durationMs));
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs,
    // != null covers undefined AND null — null means "pricing unavailable,
    // fall through to runningCostUSD computation" rather than masking unknown as 0.
    costUSD: metrics?.costUSD != null ? metrics.costUSD
      : finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: clampedMaxIdle,
    totalIdleMs: clampedTotalIdle,
    activityEvents: idle?.activityEvents ?? 0,
    inputTokens: metrics?.inputTokens ?? null,
    outputTokens: metrics?.outputTokens ?? null,
    cachedReadTokens: metrics?.cachedReadTokens ?? null,
    cachedNonReadTokens: metrics?.cachedNonReadTokens ?? null,
    turnCount: metrics?.turnCount ?? null,
    toolCallCount: metrics?.toolCallCount ?? null,
    filesReadCount: metrics?.filesReadCount ?? null,
    filesWrittenCount: metrics?.filesWrittenCount ?? null,
    verdict,
    roundsUsed,
  };
}

// Per-iteration aggregator for spec_rework / quality_rework. Each rework loop
// can run multiple iterations; the stage map only has one slot per stage, so
// we sum metrics across iterations and overwrite the slot after each one.
export interface ReworkAccumulator {
  occurred: boolean;
  durationMs: number;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedNonReadTokens: number;
  turnCount: number;
  toolCallCount: number;
  filesReadCount: number;
  filesWrittenCount: number;
  maxIdleMs: number;
  totalIdleMs: number;
  activityEvents: number;
}

export function emptyReworkAcc(): ReworkAccumulator {
  return {
    occurred: false,
    durationMs: 0, costUSD: 0,
    inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0,
    turnCount: 0, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
    maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0,
  };
}

export function accumulateReworkIteration(
  acc: ReworkAccumulator,
  result: { usage?: { inputTokens?: number | null; outputTokens?: number | null; costUSD?: number | null; cachedReadTokens?: number | null; cachedNonReadTokens?: number | null } | null; turns?: number; toolCalls?: unknown[]; filesRead?: unknown[]; filesWritten?: unknown[] },
  iterDurationMs: number,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
): void {
  acc.occurred = true;
  acc.durationMs += iterDurationMs;
  acc.costUSD += result.usage?.costUSD ?? 0;
  acc.inputTokens += result.usage?.inputTokens ?? 0;
  acc.outputTokens += result.usage?.outputTokens ?? 0;
  acc.cachedReadTokens += result.usage?.cachedReadTokens ?? 0;
  acc.cachedNonReadTokens += result.usage?.cachedNonReadTokens ?? 0;
  acc.turnCount += result.turns ?? 0;
  acc.toolCallCount += result.toolCalls?.length ?? 0;
  acc.filesReadCount += result.filesRead?.length ?? 0;
  acc.filesWrittenCount += result.filesWritten?.length ?? 0;
  if (idle) {
    if (idle.maxIdleMs > acc.maxIdleMs) acc.maxIdleMs = idle.maxIdleMs;
    acc.totalIdleMs += idle.totalIdleMs;
    acc.activityEvents += idle.activityEvents;
  }
}

export function commitReworkStage(
  stats: StageStatsMap,
  name: 'spec_rework' | 'quality_rework',
  acc: ReworkAccumulator,
  agent: { tier: 'standard' | 'complex'; model: string },
): void {
  if (!acc.occurred) return;
  (stats as Record<string, unknown>)[name] = {
    stage: name,
    entered: true,
    durationMs: acc.durationMs,
    costUSD: acc.costUSD,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: acc.maxIdleMs,
    totalIdleMs: acc.totalIdleMs,
    activityEvents: acc.activityEvents,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cachedReadTokens: acc.cachedReadTokens,
    cachedNonReadTokens: acc.cachedNonReadTokens,
    turnCount: acc.turnCount,
    toolCallCount: acc.toolCallCount,
    filesReadCount: acc.filesReadCount,
    filesWrittenCount: acc.filesWrittenCount,
  };
}

export function endVerifyStage(
  stats: StageStatsMap,
  t0: number,
  c0: number | null,
  agent: { tier: 'standard' | 'complex'; model: string },
  finalCostUSD: number | null,
  idle: { maxIdleMs: number; totalIdleMs: number; activityEvents: number } | null,
  outcome: VerifyOutcome,
  skipReason: VerifySkipReason | null,
): void {
  stats.verifying = {
    stage: 'verifying',
    entered: true,
    durationMs: Date.now() - t0,
    costUSD: finalCostUSD !== null && c0 !== null ? finalCostUSD - c0 : null,
    agentTier: agent.tier,
    modelFamily: modelFamily(agent.model),
    model: agent.model,
    maxIdleMs: idle?.maxIdleMs ?? 0,
    totalIdleMs: idle?.totalIdleMs ?? 0,
    activityEvents: idle?.activityEvents ?? 0,
    inputTokens: null,
    outputTokens: null,
    cachedReadTokens: null,
    cachedNonReadTokens: null,
    turnCount: null,
    toolCallCount: null,
    filesReadCount: null,
    filesWrittenCount: null,
    outcome,
    skipReason,
  } as StageStatsMap['verifying'];
}
