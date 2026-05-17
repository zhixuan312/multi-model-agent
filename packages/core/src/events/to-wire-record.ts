// packages/core/src/events/to-wire-record.ts
// PII projection from TaskEnvelope to wire shape. Copied functions from clamp.ts,
// normalize.ts, concern-classifier.ts so those files can be deleted in T14.

import { randomUUID } from 'node:crypto';
import { extractCanonicalModelName, findModelProfile } from '../config/model-profile-registry.js';
import type { ModelFamily } from '../config/model-profile-registry.js';
import type { TaskEnvelope } from './task-envelope.js';
import type { TaskCompletedEventType } from './wire-schema.js';
import { ValidatedTaskCompletedEventSchema } from './wire-schema.js';

// === clamp helpers (copied from clamp.ts, sans clampReasoningTokens) ===
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

export const clampToolCallCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampFilesReadCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampFilesWrittenCount = (n: number): number =>
  Math.min(Math.max(0, n), 5000);

export const clampTurnCount = (n: number): number =>
  Math.min(Math.max(0, n), 250);

export const clampDurationMsStage = (n: number): number =>
  Math.min(Math.max(0, n), 3_600_000);

export const clampDurationMsTotal = (n: number): number =>
  Math.min(Math.max(0, n), 86_400_000);

// === normalize model (verbatim from packages/core/src/events/normalize.ts) ===
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
    reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
    toolMode: 'none' | 'readonly' | 'no-shell' | 'full';
    verifyCommandPresent: boolean;
    implementerModel: string;
    implementerTier: 'standard' | 'complex';
    mainModelFamily: string;
  },
): TaskCompletedEventType {
  const { terminalStatus, workerStatus } = mapStatusToWire(
    env.status,
    (env.structuredError as { code?: string } | null)?.code ?? null,
  );

  // build stages with route-specific extras
  const wireStages = env.stages.map((s) => {
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
      toolCallCount: clampToolCallCount(s.toolCallCount),
      filesReadCount: clampFilesReadCount(s.filesReadCount),
      filesWrittenCount: clampFilesWrittenCount(s.filesWrittenCount),
      turnCount: clampTurnCount(s.turnsUsed),
      maxIdleMs: 0, // TODO: track per-stage max idle in envelope
      totalIdleMs: 0, // TODO: track per-stage total idle in envelope
      mainEquivalentCostUSD: null,
      ...(s.findingsOutcome !== undefined && { findingsOutcome: s.findingsOutcome }),
      ...(s.findingsOutcomeReason !== undefined && { findingsOutcomeReason: s.findingsOutcomeReason }),
      ...(s.outcomeInferred !== undefined && { outcomeInferred: s.outcomeInferred }),
      ...(s.outcomeMalformed !== undefined && { outcomeMalformed: s.outcomeMalformed }),
    };

    // Add route-specific fields based on stage name
    if (name === 'implementing') return base;
    if (name === 'review') {
      // Map envelope `verdict` to the wire's review verdict enum
      // (approved|concerns|changes_required|error|skipped|annotated|not_applicable).
      // Envelope holds the actual review payload's verdict ('approved' |
      // 'changes_required') after the 4.7.3 mergeStageStats fix that threaded
      // it through. Falls back to 'skipped' when the stage didn't run (review
      // gate skipped, e.g. read-route or reviewPolicy:none).
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
        roundsUsed: 1, // TODO: track round count for review stages
        concernCategories: s.concernCategories ?? [],
        findingsBySeverity: s.findingsBySeverity ?? {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        },
      };
    }
    if (name === 'rework')
      return {
        ...base,
        triggeringConcernCategories: s.concernCategories ?? [],
      };
    if (name === 'annotating') {
      // Annotate stages don't carry a `verdict` — that's a review-only field.
      // Map from envelope `s.outcome` (advance|fail|skipped) to the wire's
      // annotate-specific enum (passed|failed|skipped|not_applicable|transformed).
      // 'advance' maps to 'transformed' because annotate's success mode is
      // transforming the worker's raw report into the structured wire payload —
      // matches the legacy semantic set by terminal-handlers.ts.
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
  const tierUsageBuckets: { standard?: TierBucket; complex?: TierBucket } = {};
  for (const s of env.stages) {
    if (s.tier !== 'standard' && s.tier !== 'complex') continue;
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
  const wireAgentType: 'standard' | 'complex' = env.stages[0]?.tier ?? env.agentType;

  const record: TaskCompletedEventType = {
    eventId: randomUUID(),
    route: env.route,
    client: env.client,
    agentType: wireAgentType,
    toolMode: opts.toolMode,
    reviewPolicy: opts.reviewPolicy,
    verifyCommandPresent: opts.verifyCommandPresent,
    implementerModel: opts.implementerModel,
    implementerTier: opts.implementerTier,
    mainModel: env.mainModel,
    mainModelFamily: opts.mainModelFamily as never,
    tierUsage: tierUsageBuckets as never,
    terminalStatus: terminalStatus as never,
    workerStatus: workerStatus as never,
    errorCode: ((env.structuredError as { code?: string } | null)?.code ?? null) as never,
    inputTokens: clampInputTokens(env.totalInputTokens),
    outputTokens: clampOutputTokens(env.totalOutputTokens),
    cachedReadTokens: clampCachedTokens(env.totalCachedReadTokens),
    cachedNonReadTokens: clampCachedTokens(env.totalCachedNonReadTokens),
    totalDurationMs: clampDurationMsTotal(env.totalDurationMs),
    totalCostUSD: clampTaskCost(env.totalCostUSD),
    mainEquivalentCostUSD: null,
    costDeltaVsMainUSD: null,
    concernCount: env.findings.length,
    escalationCount: Math.max(0, distinctProviders - 1),
    fallbackCount: 0,
    filesWrittenCount: clampFilesWrittenCount(env.realFilesChanged.length),
    stallCount: env.stallCount,
    taskMaxIdleMs: env.taskMaxIdleMs,
    sandboxViolationCount: env.sandboxViolationCount,
    stages: wireStages as never,
  };

  return ValidatedTaskCompletedEventSchema.parse(record);
}
