// packages/core/src/events/to-wire-record.ts

import { randomUUID } from 'node:crypto';
import { extractCanonicalModelName, findModelProfile } from '../config/model-profile-registry.js';
import type { ModelFamily } from '../config/model-profile-registry.js';
import { resolveRateCard, priceTokens } from '../bounded-execution/cost-compute.js';
import type { TaskEnvelope } from './task-envelope.js';
import type { TaskCompletedEventType } from './wire-schema.js';
import { ValidatedTaskCompletedEventSchema } from './wire-schema.js';
import type { FindingsOutcome } from '../types/enums.js';
import { ErrorCodeSchema } from '../error-codes.js';
import type { ErrorCode } from '../error-codes.js';

// Coerce a derived error code to the canonical ErrorCode vocabulary. Providers
// and the terminal-status deriver emit codes from ErrorCodeSchema, but the
// two-phase pipeline's failure sentinel ('pipeline_failed') is a structuredError
// *detail*, not an emitter code. Any code outside the vocabulary maps to 'other'
// so a failed-pipeline task still produces a schema-valid wire record instead of
// throwing at ValidatedTaskCompletedEventSchema.parse() — which previously caused
// TelemetryUploader to silently drop the record for every failed task.
export const coerceErrorCode = (code: string | null): ErrorCode | null => {
  if (code === null) return null;
  const parsed = ErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : 'other';
};

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

/** The wire caps `concernCount` at 150. Unclamped, a reviewer that raised more
 *  failed the schema parse and the uploader dropped the ENTIRE event — the one
 *  outcome worse than an inaccurate count. */
export const clampConcernCount = (n: number): number =>
  Math.min(Math.max(0, n), 150);

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
/**
 * Project an envelope status + failure code onto the wire's `terminalStatus` / `workerStatus`.
 *
 * Every failure used to report `terminalStatus: 'error'`. The switch had seven more cases —
 * `incomplete`, `brief_too_vague`, `needs_context`, `blocked`, `review_loop_capped` and friends —
 * and not one was reachable: they are the RETIRED lifecycle vocabulary, and nothing has set
 * `structuredError.code` to any of them since that layer was removed. A test called itself
 * "exhaustive" and covered all ten branches, which is exactly why the dead ones looked alive: it
 * proved the function maps X to Y, never that anything produces X.
 *
 * v7 keeps only reachable outputs and splits three that matter operationally, because "the failure
 * rate went up" is unactionable when a wall-clock timeout, an unreachable provider and a user
 * hitting cancel are all filed as the same word:
 *
 *   - `timeout`     — the run hit its wall clock. A budget question.
 *   - `unavailable` — the provider could not be reached or authenticated. An infrastructure fact
 *                     about the operator's environment, not a statement about the engine.
 *   - `cancelled`   — the caller aborted it. Not a failure at all, and counting it as one made
 *                     every interactive session look unreliable.
 *
 * Anything else stays `error`.
 */

/** Provider/pipeline codes that mean "we never got to run", not "the work went wrong". */
const UNAVAILABLE_CODES = new Set([
  'missing_credentials',
  'invalid_api_key',
  'codex_not_installed',
  'spawn_failed',
  'sdk_no_result',
]);

export function mapStatusToWire(
  status: TaskEnvelope['status'],
  errCode: string | null,
  wasCancelled = false,
): {
  terminalStatus: 'ok' | 'timeout' | 'error' | 'unavailable' | 'cancelled';
  workerStatus: 'done' | 'done_with_concerns' | 'failed' | 'cancelled';
} {
  // Checked before status: a cancel usually lands as a `failed` pipeline with an
  // `aborted` code, and reading the code alone cannot tell a caller-initiated
  // abort from the engine giving up.
  if (wasCancelled) return { terminalStatus: 'cancelled', workerStatus: 'cancelled' };
  if (status === 'done') return { terminalStatus: 'ok', workerStatus: 'done' };
  if (status === 'done_with_concerns') {
    return { terminalStatus: 'ok', workerStatus: 'done_with_concerns' };
  }
  if (errCode === 'aborted') return { terminalStatus: 'cancelled', workerStatus: 'cancelled' };
  if (errCode === 'wall_clock_exceeded') return { terminalStatus: 'timeout', workerStatus: 'failed' };
  if (errCode !== null && UNAVAILABLE_CODES.has(errCode)) {
    return { terminalStatus: 'unavailable', workerStatus: 'failed' };
  }
  return { terminalStatus: 'error', workerStatus: 'failed' };
}

// === main projection ===
export function toWireRecord(
  env: TaskEnvelope,
  opts: {
    toolMode: 'none' | 'readonly' | 'no-shell' | 'full';
    implementerModel: string;
    implementerTier: 'standard' | 'complex' | 'main';
    mainModelFamily: ModelFamily;
  },
): TaskCompletedEventType {
  const { terminalStatus, workerStatus } = mapStatusToWire(
    env.status,
    env.errorCode ?? ((env.structuredError as { code?: string } | null)?.code ?? null),
    env.wasCancelled,
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
    // `reviewing` is the wire's `review`; there is no third case — see StageName. The literal
    // is applied per-branch below rather than shared here, so the discriminated union in
    // `StageEntrySchema` resolves without a cast.
    const base = {
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
      mainCostUSD: mainCard
        ? priceTokens({
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cachedReadTokens: s.cachedReadTokens ?? 0,
            cachedNonReadTokens: s.cachedNonReadTokens ?? 0,
          }, mainCard)
        : null,
    };

    // 4.7.4+: findingsBySeverity / findingsOutcome / outcomeInferred / outcomeMalformed are
    // top-level only — stages do NOT carry them.
    if (s.name === 'implementing') return { ...base, name: 'implementing' as const };

    // Map envelope `verdict` to the wire's review verdict enum.
    const reviewVerdict = s.verdict;
    let wireVerdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'annotated' | 'not_applicable';
    if (reviewVerdict === 'approved' || reviewVerdict === 'changes_required'
        || reviewVerdict === 'concerns' || reviewVerdict === 'error') {
      wireVerdict = reviewVerdict;
    } else if (s.outcome === 'fail') {
      wireVerdict = 'error';
    } else {
      wireVerdict = 'skipped';
    }
    return {
      ...base,
      name: 'review' as const,
      verdict: wireVerdict,
      // Both bounds the schema declares: 16 categories, 64 chars each. One
      // over-long category used to fail the parse and drop the whole event.
      concernCategories: (s.concernCategories ?? []).slice(0, 16).map((c) => c.slice(0, 64)),
    };
  });

  // Group envelope tool-call records by (stage, turn, tool) into wire-safe
  // cardinality counts. `ts` and `filesWritten` are dropped here — only the
  // grouped counts ever reach the wire, never a raw file path (PII rule).
  // Ordering: stage, then turn, then tool — matches first-seen insertion
  // order of the (stage, turn, tool) key, which is stable because
  // env.toolCalls is itself recorded in chronological (stage, turn) order.
  const toolCallGroups = new Map<string, { stage: string; turn: number; tool: string; count: number }>();
  for (const tc of env.toolCalls) {
    const key = `${tc.stage}\u0000${tc.turn}\u0000${tc.tool}`;
    const existing = toolCallGroups.get(key);
    if (existing) existing.count += 1;
    else toolCallGroups.set(key, { stage: tc.stage, turn: tc.turn, tool: tc.tool, count: 1 });
  }
  // Sort explicitly by (stage, turn, tool) — the contract's ordering
  // invariant — rather than relying on env.toolCalls' recording order.
  const wireToolCalls = [...toolCallGroups.values()]
    .sort((a, b) =>
      a.stage.localeCompare(b.stage) || a.turn - b.turn || a.tool.localeCompare(b.tool))
    .slice(0, 500);

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
    // NOT nullable, unlike the StageRecord fields they accumulate from: a bucket is created
    // with zeros and only ever added to. Declaring them nullable forced a `bucket.x !== null`
    // guard that could not fire, and an `as never` at the schema boundary to paper over the
    // resulting mismatch — which is what hid the missing `main` key.
    cachedReadTokens: number;
    cachedNonReadTokens: number;
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
    if (s.cachedReadTokens !== null) bucket.cachedReadTokens += s.cachedReadTokens;
    if (s.cachedNonReadTokens !== null) bucket.cachedNonReadTokens += s.cachedNonReadTokens;
  }
  // Prefer the first stage's tier as the task's headline agentType — matches
  // implementerTier's derivation and reflects what the task actually used,
  // not whatever default async-dispatch seeded the envelope with.
  const wireAgentType: 'standard' | 'complex' | 'main' = env.stages[0]?.tier ?? env.agentType;

  // What this run WOULD have cost on the configured main tier — the baseline both
  // `mainCostUSD` and `costDeltaVsMainUSD` are expressed against.
  const taskMainCostUSD = mainCard
    ? priceTokens({
        inputTokens: env.totalInputTokens,
        outputTokens: env.totalOutputTokens,
        cachedReadTokens: env.totalCachedReadTokens,
        cachedNonReadTokens: env.totalCachedNonReadTokens,
      }, mainCard)
    : null;

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
    mainModelFamily: opts.mainModelFamily,
    // No cast: the bucket shape and the schema agree, and the cast is what hid the missing
    // `main` key from the typechecker while Zod quietly dropped it at parse.
    tierUsage: tierUsageBuckets,
    terminalStatus,
    workerStatus,
    errorCode: coerceErrorCode(env.errorCode ?? ((env.structuredError as { code?: string } | null)?.code ?? null)),
    inputTokens: clampInputTokens(env.totalInputTokens),
    outputTokens: clampOutputTokens(env.totalOutputTokens),
    cachedReadTokens: clampCachedTokens(env.totalCachedReadTokens),
    cachedNonReadTokens: clampCachedTokens(env.totalCachedNonReadTokens),
    totalDurationMs: clampDurationMsTotal(env.totalDurationMs),
    totalCostUSD: clampTaskCost(env.totalCostUSD),
    mainCostUSD: taskMainCostUSD,
    // Subtracted from the SAME value reported above, not a second identical `priceTokens` call.
    // Two copies of one expression let the delta silently stop being `actual - mainCostUSD` the
    // moment one of them is edited.
    costDeltaVsMainUSD: taskMainCostUSD === null ? null : clampTaskCost(env.totalCostUSD) - taskMainCostUSD,
    concernCount: clampConcernCount(env.findings.length),
    // Built from the SAME clamped list the count comes from, so R17
    // (histogram sums to concernCount) cannot be violated by the clamp itself.
    findingsBySeverity: env.findings.slice(0, 150).reduce(
      (acc, f) => {
        const s = f.severity;
        if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low') acc[s] += 1;
        return acc;
      },
      { critical: 0, high: 0, medium: 0, low: 0 },
    ),
    // 4.7.4+ outcome rollup. Source priority: review → implementing. `annotating` sat between
    // them and is gone with the stage — see StageName in task-envelope.ts.
    // Each stage stores the same value the worker / reviewer emitted; the first
    // non-null wins because later stages mirror earlier ones (see the
    // outcomePriority walk below). Top-level is the single source backend + frontend read.
    ...(() => {
      const outcomePriority: Array<'reviewing' | 'implementing'> = ['reviewing', 'implementing'];
      type StageWithOutcome = {
        name: string;
        findingsOutcome?: FindingsOutcome | null;
        findingsOutcomeReason?: string | null;
      };
      const pick = outcomePriority
        .map((n) => (env.stages as StageWithOutcome[]).find((st) => st.name === n && st.findingsOutcome != null))
        .find((s): s is StageWithOutcome => s !== undefined);
      if (!pick) return {};
      return {
        findingsOutcome: pick.findingsOutcome ?? undefined,
        ...(pick.findingsOutcomeReason !== undefined && { findingsOutcomeReason: pick.findingsOutcomeReason }),
      };
    })(),
    filesWrittenCount: clampFilesWrittenCount(env.realFilesChanged.length),
    sandboxViolationCount: env.sandboxViolationCount,
    stages: wireStages,
    toolCalls: wireToolCalls,
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
