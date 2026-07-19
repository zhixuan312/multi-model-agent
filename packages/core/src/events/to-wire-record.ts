// packages/core/src/events/to-wire-record.ts

import { randomUUID } from 'node:crypto';
import { extractCanonicalModelName, findModelProfile } from '../config/model-profile-registry.js';
import type { ModelFamily } from '../config/model-profile-registry.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';
import type { TaskEnvelope } from './task-envelope.js';
import type { TaskCompletedEventType } from './wire-schema.js';
import { ValidatedTaskCompletedEventSchema } from './wire-schema.js';
import type { FindingsOutcome } from '../types/enums.js';

// === clamp helpers — bound each wire field to a sane range before emit ===
export const clampStageCost = (n: number): number =>
  Math.max(0, Math.min(Math.round(n * 1_000_000) / 1_000_000, 500));

export const clampTaskCost = (n: number): number =>
  Math.max(0, Math.min(n, 5_000));

export const clampInputTokens = (n: number): number =>
  Math.min(Math.max(0, n), 100_000_000);

export const clampOutputTokens = (n: number): number =>
  Math.min(Math.max(0, n), 2_000_000);

export const clampCachedTokens = (n: number): number =>
  Math.min(Math.max(0, n), 100_000_000);

export const clampFilesWrittenCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampTurnCount = (n: number): number =>
  Math.min(Math.max(0, n), 250);

export const clampDurationMsStage = (n: number): number =>
  Math.min(Math.max(0, n), 3_600_000);

export const clampDurationMsTotal = (n: number): number =>
  Math.min(Math.max(0, n), 86_400_000);

// === normalize model ===
/**
 * Normalize a raw model ID into its canonical name and family.
 *
 * Combines prefix stripping (extractCanonicalModelName) with profile
 * lookup (findModelProfile) into a single call. Callers that need both
 * the canonical form and the family without reaching into routing
 * internals should use this entry point.
 *
 * Idempotent: the canonical output of normalizeModel, when fed back
 * in as input, produces the same canonical output.
 */
export function normalizeModel(rawModelId: string): { canonical: string; family: ModelFamily } {
  const canonical = extractCanonicalModelName(rawModelId);
  const family = findModelProfile(canonical).family;
  return { canonical, family };
}

// === status mapping per spec ===
export function mapStatusToWire(
  status: TaskEnvelope['status'],
  errCode: string | null,
): { terminalStatus: string; workerStatus: string } {
  if (status === 'done') return { terminalStatus: 'ok', workerStatus: 'done' };
  if (status === 'done_with_concerns')
    return { terminalStatus: 'ok', workerStatus: 'done_with_concerns' };
  // failed:
  switch (errCode) {
    case 'incomplete':
      return { terminalStatus: 'incomplete', workerStatus: 'failed' };
    case 'timeout':
      return { terminalStatus: 'timeout', workerStatus: 'failed' };
    case 'brief_too_vague':
      return { terminalStatus: 'brief_too_vague', workerStatus: 'failed' };
    case 'unavailable':
      return { terminalStatus: 'unavailable', workerStatus: 'failed' };
    case 'needs_context':
      return { terminalStatus: 'incomplete', workerStatus: 'needs_context' };
    case 'blocked':
      return { terminalStatus: 'incomplete', workerStatus: 'blocked' };
    case 'review_loop_capped':
      return { terminalStatus: 'incomplete', workerStatus: 'review_loop_capped' };
    default:
      return { terminalStatus: 'error', workerStatus: 'failed' };
  }
}

// === main projection ===
export function toWireRecord(
  env: TaskEnvelope,
  opts: {
    toolMode: 'none' | 'readonly' | 'no-shell' | 'full';
    implementerModel: string;
    implementerTier: 'standard' | 'complex' | 'main';
    mainModelFamily: string;
  },
): TaskCompletedEventType {
  const { terminalStatus, workerStatus } = mapStatusToWire(
    env.status,
    (env.structuredError as { code?: string } | null)?.code ?? null,
  );

  // Resolve the main model's rate card once; per-stage and top-level
  // mainCostUSD reuse it. Null when mainModel is unset or unknown to the
  // profile registry — in that case mainCostUSD / costDeltaVsMainUSD stay
  // null at every level (per PRIVACY.md). Restored after the v4.7.2
  // envelope-unification refactor accidentally dropped this compute
  // (regression introduced when event-builder.ts was deleted).
  const mainCard = resolveRateCard(env.mainModel);

  // Build stages with route-specific extras.
  //
  // Non-LLM filter: drop stages that recorded no LLM activity (zero tokens AND
  // zero/null cost). The committing stage always falls here (git commit only,
  // no LLM call), and so do skipped review/rework/annotate stages. Including
  // them in the wire payload was misleading — readers saw a "stage" row with
  // nothing to attribute to a model. We keep them on the in-memory envelope
  // (for completeStage's bookkeeping + duration roll-up) but strip them from
  // the wire serialization.
  const wireStages = env.stages
    .filter((s) => {
      const hasTokens = s.inputTokens > 0 || s.outputTokens > 0;
      const hasCost = (s.costUSD ?? 0) > 0;
      return hasTokens || hasCost;
    })
    .map((s) => {
    const name =
      s.name === 'implementing'
        ? 'implementing'
        : s.name === 'reviewing'
          ? 'review'
          : s.name === 'reworking'
            ? 'rework'
            : s.name === 'annotating'
              ? 'annotating'
              : 'committing';

    const base = {
      name,
      round: s.round,
      model: normalizeModel(s.model).canonical,
      tier: s.tier,
      durationMs: clampDurationMsStage(s.durationMs),
      costUSD: s.costUSD === null ? null : clampStageCost(s.costUSD),
      inputTokens: clampInputTokens(s.inputTokens),
      outputTokens: clampOutputTokens(s.outputTokens),
      cachedReadTokens: s.cachedReadTokens === null ? null : clampCachedTokens(s.cachedReadTokens),
      cachedNonReadTokens:
        s.cachedNonReadTokens === null ? null : clampCachedTokens(s.cachedNonReadTokens),
      filesWrittenCount: clampFilesWrittenCount(s.filesWrittenCount),
      turnCount: clampTurnCount(s.turnsUsed),
      maxIdleMs: 0,
      totalIdleMs: 0,
      mainCostUSD: mainCard
        ? priceTokens({
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cachedReadTokens: s.cachedReadTokens ?? 0,
            cachedNonReadTokens: s.cachedNonReadTokens ?? 0,
          }, mainCard)
        : null,
    };

    // Add route-specific fields based on stage name.
    // 4.7.4+: findingsBySeverity / findingsOutcome / outcomeInferred /
    // outcomeMalformed are top-level only — stages do NOT carry them.
    if (name === 'implementing') return base;
    if (name === 'review') {
      // Map envelope `verdict` to the wire's review verdict enum.
      const reviewVerdict = s.verdict;
      let wireVerdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'annotated' | 'not_applicable';
      if (reviewVerdict === 'approved' || reviewVerdict === 'changes_required'
          || reviewVerdict === 'concerns' || reviewVerdict === 'error') {
        wireVerdict = reviewVerdict;
      } else if (s.outcome === 'skipped' || s.outcome === null) {
        wireVerdict = 'skipped';
      } else if (s.outcome === 'fail') {
        wireVerdict = 'error';
      } else {
        wireVerdict = 'skipped';
      }
      return {
        ...base,
        verdict: wireVerdict as never,
        roundsUsed: 1,
        concernCategories: s.concernCategories ?? [],
      };
    }
    if (name === 'rework')
      return {
        ...base,
        triggeringConcernCategories: s.concernCategories ?? [],
      };
    if (name === 'annotating') {
      const ann = s as { outcome?: 'advance' | 'fail' | 'skipped' | null };
      let out: 'transformed' | 'failed' | 'skipped' | 'not_applicable' | 'passed';
      if (ann.outcome === 'advance') out = 'transformed';
      else if (ann.outcome === 'fail') out = 'failed';
      else out = 'skipped';
      return {
        ...base,
        outcome: out as never,
        skipReason: (s.skipReason ?? null) as never,
      };
    }
    // committing
    return {
      ...base,
      filesCommittedCount: s.filesCommittedCount ?? 0,
      branchCreated: s.branchCreated ?? false,
    };
  });

  const distinctProviders = new Set(
    env.escalationLog
      .map((e) => (e as { toModel?: string }).toModel ?? '')
      .filter(Boolean),
  ).size;

  // Aggregate per-tier usage from the envelope's stages array. Each stage
  // already carries `tier`, `model`, `costUSD`, and token counts; bucket by
  // tier and sum. Without this, downstream telemetry can't break out
  // standard-vs-complex cost/token usage and standard_model / complex_model
  // columns stay NULL in the DB.
  type TierBucket = {
    model: string;
    costUSD: number | null;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number | null;
    cachedNonReadTokens: number | null;
  };
  const tierUsageBuckets: { standard?: TierBucket; complex?: TierBucket; main?: TierBucket } = {};
  for (const s of env.stages) {
    if (s.tier !== 'standard' && s.tier !== 'complex' && s.tier !== 'main') continue;
    // Match the wire stages filter: only LLM-active stages contribute to the
    // per-tier rollup. A committing or skipped stage with zero tokens and
    // zero cost would otherwise seed bucket.model from a stage that did no
    // LLM work, leaking the wrong model into the tier bucket.
    const hasTokens = s.inputTokens > 0 || s.outputTokens > 0;
    const hasCost = (s.costUSD ?? 0) > 0;
    if (!hasTokens && !hasCost) continue;
    const bucket = tierUsageBuckets[s.tier] ?? {
      model: normalizeModel(s.model).canonical,
      costUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedNonReadTokens: 0,
    };
    if (!tierUsageBuckets[s.tier]) tierUsageBuckets[s.tier] = bucket;
    bucket.costUSD = (bucket.costUSD ?? 0) + (s.costUSD ?? 0);
    bucket.inputTokens += s.inputTokens;
    bucket.outputTokens += s.outputTokens;
    if (s.cachedReadTokens !== null && bucket.cachedReadTokens !== null) bucket.cachedReadTokens += s.cachedReadTokens;
    if (s.cachedNonReadTokens !== null && bucket.cachedNonReadTokens !== null) bucket.cachedNonReadTokens += s.cachedNonReadTokens;
  }
  // Prefer the first stage's tier as the task's headline agentType — matches
  // implementerTier's derivation and reflects what the task actually used,
  // not whatever default async-dispatch seeded the envelope with.
  const wireAgentType: 'standard' | 'complex' | 'main' = env.stages[0]?.tier ?? env.agentType;

  const record: TaskCompletedEventType = {
    eventId: randomUUID(),
    route: env.route,
    client: env.client,
    agentType: wireAgentType,
    toolMode: opts.toolMode,
    reviewPolicy: env.reviewPolicy,
    implementerModel: opts.implementerModel,
    implementerTier: opts.implementerTier,
    mainModel: env.mainModel,
    mainModelFamily: opts.mainModelFamily as never,
    tierUsage: tierUsageBuckets as never,
    terminalStatus: terminalStatus as never,
    workerStatus: workerStatus as never,
    errorCode: (env.errorCode ?? ((env.structuredError as { code?: string } | null)?.code ?? null)) as never,
    inputTokens: clampInputTokens(env.totalInputTokens),
    outputTokens: clampOutputTokens(env.totalOutputTokens),
    cachedReadTokens: clampCachedTokens(env.totalCachedReadTokens),
    cachedNonReadTokens: clampCachedTokens(env.totalCachedNonReadTokens),
    totalDurationMs: clampDurationMsTotal(env.totalDurationMs),
    totalCostUSD: clampTaskCost(env.totalCostUSD),
    mainCostUSD: mainCard
      ? priceTokens({
          inputTokens: env.totalInputTokens,
          outputTokens: env.totalOutputTokens,
          cachedReadTokens: env.totalCachedReadTokens,
          cachedNonReadTokens: env.totalCachedNonReadTokens,
        }, mainCard)
      : null,
    costDeltaVsMainUSD: mainCard
      ? clampTaskCost(env.totalCostUSD) - priceTokens({
          inputTokens: env.totalInputTokens,
          outputTokens: env.totalOutputTokens,
          cachedReadTokens: env.totalCachedReadTokens,
          cachedNonReadTokens: env.totalCachedNonReadTokens,
        }, mainCard)
      : null,
    concernCount: env.findings.length,
    findingsBySeverity: env.findings.reduce(
      (acc, f) => {
        const s = f.severity;
        if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') acc[s] += 1;
        return acc;
      },
      { critical: 0, high: 0, medium: 0, low: 0 },
    ),
    // 4.7.4+ outcome rollup. Source priority: review → annotating → implementing.
    // Each stage stores the same value the worker / reviewer emitted; the first
    // non-null wins because later stages mirror earlier ones (see the
    // outcomePriority walk below). Top-level is the single source backend + frontend read.
    ...(() => {
      const outcomePriority: Array<'reviewing' | 'annotating' | 'implementing'> = ['reviewing', 'annotating', 'implementing'];
      type StageWithOutcome = {
        name: string;
        findingsOutcome?: FindingsOutcome | null;
        findingsOutcomeReason?: string | null;
        outcomeInferred?: boolean;
        outcomeMalformed?: boolean;
      };
      const pick = outcomePriority
        .map((n) => (env.stages as StageWithOutcome[]).find((st) => st.name === n && st.findingsOutcome != null))
        .find((s): s is StageWithOutcome => s !== undefined);
      if (!pick) return {};
      return {
        findingsOutcome: pick.findingsOutcome ?? undefined,
        ...(pick.findingsOutcomeReason !== undefined && { findingsOutcomeReason: pick.findingsOutcomeReason }),
        ...(pick.outcomeInferred !== undefined && { outcomeInferred: pick.outcomeInferred }),
        ...(pick.outcomeMalformed !== undefined && { outcomeMalformed: pick.outcomeMalformed }),
      };
    })(),
    escalationCount: Math.max(0, distinctProviders - 1),
    fallbackCount: 0,
    filesWrittenCount: clampFilesWrittenCount(env.realFilesChanged.length),
    stallCount: env.stallCount,
    taskMaxIdleMs: env.taskMaxIdleMs,
    sandboxViolationCount: env.sandboxViolationCount,
    stages: wireStages as never,
    // 4.7.5: surface parser-side validation warnings (dropped Findings, malformed
    // bullets) on the wire so the backend can analytics on output-format drift.
    // Optional in schema — absent for healthy events; populated only when the
    // findings-parser warnSink fired during this task.
    ...(env.validationWarnings.length > 0 && {
      validation_warnings: env.validationWarnings.map((w) => ({ rule: w.rule, path: w.path })),
    }),
  };

  return ValidatedTaskCompletedEventSchema.parse(record);
}
