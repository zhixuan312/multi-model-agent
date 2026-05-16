import { randomUUID } from 'node:crypto';
import type { RuntimeRunResult, RawStageStats } from '../types.js';
import type { RawStageStatsShape } from '../types/run-result.js';
import type { StageGate } from '../lifecycle/stage-io.js';
import { normalizeModel } from './normalize.js';
import { classifyConcern } from './concern-classifier.js';
import { ErrorCode, type TaskCompletedEventType, type StageEntryType, type StageEntryInternal, type ConcernCategoryType, type WireTelemetryRecord, WireTelemetryRecordSchema } from './telemetry-types.js';

import { bucketFindingsBySeverity } from '../reporting/severity.js';
import { rollupByTier, sumTokens } from '../bounded-execution/cost-rollup.js';
import { priceTokens, resolveRateCard } from '../bounded-execution/cost-compute.js';
import {
  clampStageCost,
  clampTaskCost,
  clampInputTokens,
  clampOutputTokens,
  clampCachedTokens,
  clampToolCallCount,
  clampFilesReadCount,
  clampFilesWrittenCount,
  clampTurnCount,
  clampDurationMsStage,
  clampDurationMsTotal,
} from './clamp.js';

/**
 * Thrown when a stage marked `isLlmStage: true` arrives at the builder
 * with no model identifier. Caught one level up by the stage-build loop
 * (Task A5b) and converted into a `validation_warnings` diagnostic; the
 * offending stage is dropped from the emitted event but the rest of the
 * event still ships. Per spec D5 + §6.
 */
export class StageModelMissingError extends Error {
  constructor(public readonly stageName: string) {
    super(`Stage '${stageName}' is marked isLlmStage:true but raw.model is null.`);
    this.name = 'StageModelMissingError';
  }
}

export interface BuildContext {
  route: 'delegate' | 'audit' | 'review' | 'debug' | 'execute-plan' | 'retry' | 'investigate' | 'research' | 'register-context-block';
  taskSpec: { filePaths?: string[]; subtype?: string };
  runResult: RuntimeRunResult;
  realFilesChanged: string[];   // NEW — sub-project A. Absolute paths from getRealFilesChanged.
  client: string;
  mainModel: string | null;
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
  verifyCommandPresent?: boolean;
  /**
   * v5 — per-stage gates from LifecycleState. When present, the wire builder
   * cross-checks each stage's runResult.stageStats against gates[name].telemetry
   * and prefers the gate's values for `costUSD`, `durationMs`, `turnsUsed`,
   * `stopReason` (the canonical v5 source). stageStats supplies the remaining
   * fields (tokens, tool calls, files read/written) because they're not on the
   * gate's telemetry block.
   */
  gates?: Record<string, StageGate<unknown>>;
}

const REVIEWED_ROUTES = new Set(['delegate', 'audit', 'review', 'debug', 'execute-plan', 'investigate']);
const QUALITY_ONLY_ROUTES = new Set(['audit', 'review', 'debug', 'investigate']);

/**
 * Catches StageModelMissingError thrown by LLM stage builders and converts
 * it into a validation warning. The stage is dropped from the emitted event,
 * but the rest of the event still ships. Per spec §6 + task A5b.
 */
function safeBuild<T>(
  name: string,
  fn: () => T | null,
  validationWarnings: Array<{ path: string; rule: string }>,
): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StageModelMissingError) {
      validationWarnings.push({ path: `stages.${name}`, rule: 'StageModelMissingError' });
      return null;
    }
    throw e;
  }
}

/** Projected finding shape used internally by the wire builder. Severity is
 *  always one of the 4-tier values (defaults to 'medium' when the source
 *  field lacked one, matching the wire's pre-existing default-medium policy). */
interface ProjectedFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  source: 'spec_review' | 'quality_review' | 'review' | 'implementer';
  message: string;
}

/** Read findings from the v4.4 lifecycle sources:
 *   - structuredReport.findings  → read-only routes (audit/review/debug/investigate/research/explore)
 *   - structuredReport.reviewConcerns → reviewed write routes (delegate/execute-plan)
 *
 *  Both fields are populated by lifecycle/handlers/annotator.ts. The pre-v4.4
 *  `runResult.concerns` field is dead — the v4.4 lifecycle never assigns it,
 *  so reading from there silently produced concernCount=0 on every event.
 */
function projectFindings(rr: RuntimeRunResult): ProjectedFinding[] {
  // The annotator handler writes a richer shape than ParsedStructuredReport declares;
  // cast to the runtime-actual shape.
  const sr = rr.structuredReport as {
    findings?: ReadonlyArray<{ severity?: string; category?: string; claim?: string }>;
    reviewConcerns?: ReadonlyArray<string>;
  } | undefined;

  const out: ProjectedFinding[] = [];

  for (const f of sr?.findings ?? []) {
    out.push({
      severity: normalizeSeverity(f.severity),
      source: 'implementer',
      message: f.claim ?? '',
    });
  }

  for (const text of sr?.reviewConcerns ?? []) {
    out.push({ severity: 'medium', source: 'review', message: text });
  }

  return out;
}

function normalizeSeverity(s: string | undefined): ProjectedFinding['severity'] {
  const v = (s ?? '').toLowerCase().trim();
  if (v === 'critical' || v === 'high' || v === 'low') return v;
  return 'medium';
}

export function buildTaskCompletedEvent(ctx: BuildContext): WireTelemetryRecord {
  const { route, runResult, client, mainModel } = ctx;

  const validationWarnings: Array<{ path: string; rule: string }> = [];
  const stages = buildStages(route, runResult, ctx.gates, validationWarnings);

  // Compute per-stage main-model-equivalent cost using the resolved rate card.
  // Plugs into StageEntryBase.mainEquivalentCostUSD so the schema stays valid
  // without weakening the field to optional.
  const mainCard = resolveRateCard(mainModel);
  for (const st of stages) {
    (st as any).mainEquivalentCostUSD = mainCard
      ? priceTokens(
          { inputTokens: st.inputTokens, outputTokens: st.outputTokens,
            cachedReadTokens: st.cachedReadTokens ?? 0, cachedNonReadTokens: st.cachedNonReadTokens ?? 0 },
          mainCard,
        )
      : null;
  }

  // Spec D11: when the implementing or rework stage was dropped due to
  // StageModelMissingError, omit tierUsage.<tier> entirely — do not let
  // another stage's model become the tier attribution.
  const droppedImpl = validationWarnings.some(w =>
    w.rule === 'StageModelMissingError'
    && (w.path === 'stages.implementing' || w.path === 'stages.rework')
  );
  const droppedTier: 'standard' | 'complex' =
    (runResult.stageStats?.implementing?.agentTier === 'complex') ? 'complex' : 'standard';

  // Gap 3 fix (4.0.3+): R4 invariant `totalDurationMs >= Σ stage.durationMs`
  // is satisfied by Math.max-ing the executor wall-clock against the stage
  // sum. Pre-fix, runResult.durationMs only covered the implementer's
  // shell.run — reviewer/annotator wall-clocks were excluded, making
  // totalDurationMs a fraction of reality. The proportional scale-down
  // that "fixed" this masked the under-counting by silently shrinking
  // every per-stage duration to fit. Now:
  //
  //   1. Compute the FINAL serialized stage values first (each stage's
  //      durationMs is already clamped via clampDurationMsStage in
  //      extractStageData → see line ~233). Per round-2 audit F4: the
  //      sum MUST be of final serialized values, so post-clamp/round
  //      drift can't re-introduce R4 violations.
  //   2. totalDurationMs = max(executor wall-clock, sum of stage durations).
  //      For sequential v4 stages this picks the stage sum (correct);
  //      pre-v4 salvage paths still get runResult.durationMs as floor.
  //   3. NO proportional scale-down. Per-stage durations stay truthful.
  //      If Σ ever exceeded total in some unforeseen path, we'd want to
  //      see the bug, not silently mask it.
  const stageDurationsSum = stages.reduce((s, st) => s + st.durationMs, 0);
  const rawTotal = Math.max(runResult.durationMs ?? 0, stageDurationsSum);
  const totalDurationMs = clampDurationMsTotal(rawTotal);

  // ── Tier-level rollup (§3.2, §3.3) ───────────────────────────────────
  // Filter to LLM-billable stages only — synthetic stages (annotated
  // placeholder review on read-only routes, the commit stage) carry
  // model: 'custom' and would corrupt tier rollup under last-seen
  // semantics. Per spec §4.1.1 and §4.1.2.
  const llmStages = stages.filter(s => s.isLlmStage);

  // Tier-uniformity invariant (spec D9). Every LLM-billable stage at
  // a given tier must share the same canonical model id. If violated,
  // omit that tier from tierUsage and record a diagnostic — better
  // honest-null than silent-wrong attribution.
  const tierModels: Partial<Record<'standard' | 'complex', Set<string>>> = {};
  for (const s of llmStages) {
    const tier = s.tier as 'standard' | 'complex';
    const set = tierModels[tier] ?? new Set<string>();
    set.add(s.model);
    tierModels[tier] = set;
  }
  const divergentTiers = new Set<'standard' | 'complex'>();
  for (const tier of ['standard', 'complex'] as const) {
    if ((tierModels[tier]?.size ?? 0) > 1) {
      divergentTiers.add(tier);
      validationWarnings.push({ path: `tierUsage.${tier}`, rule: 'R-TIER-MODEL-DIVERGENCE' });
    }
  }

  if (droppedImpl) {
    divergentTiers.add(droppedTier);
  }

  const rollupInput = llmStages.filter(s => !divergentTiers.has(s.tier as 'standard' | 'complex'));

  const tierUsage = rollupByTier(rollupInput.map(s => ({
    tier: s.tier as 'standard' | 'complex',
    model: s.model,
    costUSD: s.costUSD,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedReadTokens: s.cachedReadTokens ?? 0,
    cachedNonReadTokens: s.cachedNonReadTokens ?? 0,
  })));

  const allTokens = sumTokens(stages.map(s => ({
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedReadTokens: s.cachedReadTokens ?? 0,
    cachedNonReadTokens: s.cachedNonReadTokens ?? 0,
  })));

  // Honest-null: ANY contributing stage with costUSD: null poisons the total.
  // Matches rollupByTier semantics — invariant: Σ tierUsage[T].costUSD === totalCostUSD
  // (both null OR both equal).
  const anyNullCost = stages.some(s => s.costUSD === null);
  const totalCostUSD = stages.length === 0
    ? 0
    : (anyNullCost ? null : clampTaskCost(stages.reduce((sum, s) => sum + (s.costUSD as number), 0)));

  const totalInputTokens = clampInputTokens(allTokens.inputTokens);
  const totalOutputTokens = clampOutputTokens(allTokens.outputTokens);
  const totalCachedReadTokens = clampCachedTokens(allTokens.cachedReadTokens);
  const totalCachedNonReadTokens = clampCachedTokens(allTokens.cachedNonReadTokens);

  const mainEquivalentCostUSD = mainCard ? priceTokens(allTokens, mainCard) : null;

  const costDeltaVsMainUSD = (totalCostUSD === null || mainEquivalentCostUSD === null)
    ? null
    : totalCostUSD - mainEquivalentCostUSD;

  // Canonicalize mainModel for emission (matches implementerModel emission path).
  const mainNormalized = mainModel ? normalizeModel(mainModel) : null;

  const reviewPolicy = ctx.reviewPolicy ?? (QUALITY_ONLY_ROUTES.has(route) ? 'quality_only' : 'full');
  const verifyCommandPresent = ctx.verifyCommandPresent ?? false;

  const implModelRaw = runResult.models?.implementer ?? null;
  const implResult = implModelRaw ? normalizeModel(implModelRaw) : null;

  const escalationLog = runResult.escalationLog ?? [];
  const distinctProviders = new Set(escalationLog.map(a => a.provider)).size;
  const escalationCount = Math.max(0, distinctProviders - 1);

  // Strip producer-internal isLlmStage before wire emission. Wire schema
  // (telemetry-types.ts) does not include this field; backend transformer
  // does not read it. Per spec D2.
  const wireStages = stages.map(s => {
    const { isLlmStage: _drop, ...rest } = s;
    return rest;
  });

  const internalRecord = {
    eventId: randomUUID(),
    route,
    subtype: ctx.taskSpec.subtype ?? null,
    client,
    agentType: runResult.agents?.implementer === 'complex' ? 'complex' : 'standard',
    toolMode: (runResult.agents?.implementerToolMode ?? 'full') as 'none' | 'readonly' | 'no-shell' | 'full',
    reviewPolicy,
    verifyCommandPresent,
    implementerModel:
      implResult?.canonical
      ?? runResult.models?.implementer
      ?? runResult.stageStats?.implementing?.model
      ?? 'custom',
    implementerTier: (runResult.stageStats?.implementing?.agentTier as 'standard' | 'complex') ?? 'standard',
    terminalStatus: deriveTerminalStatus(runResult),
    workerStatus: deriveWorkerStatus(runResult),
    errorCode: deriveErrorCode(runResult),
    mainModel: mainNormalized?.canonical ?? null,
    mainModelFamily: mainNormalized?.family ?? 'other',
    tierUsage,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedReadTokens: totalCachedReadTokens,
    cachedNonReadTokens: totalCachedNonReadTokens,
    totalDurationMs,
    totalCostUSD,
    mainEquivalentCostUSD,
    costDeltaVsMainUSD,
    concernCount: Math.min(projectFindings(runResult).length, 150),
    escalationCount,
    fallbackCount: Math.min(runResult.agents?.fallbackOverrides?.length ?? 0, 20),
    stallCount: Math.min(runResult.stallCount ?? (runResult.stallTriggered ? 1 : 0), 20),
    taskMaxIdleMs: runResult.taskMaxIdleMs ?? 0,
    sandboxViolationCount: Math.min((runResult as any).sandboxViolationCount ?? 0, 100),
    filesWrittenCount: (ctx.realFilesChanged ?? []).length,
    stages: wireStages,
    validation_warnings: validationWarnings.length > 0 ? validationWarnings : undefined,
  };

  return buildWirePayload(internalRecord);
}

/**
 * Wire payload builder. Internal record fields match the wire schema 1:1
 * after the v4.0.3 rename (mainModel/mainModelFamily everywhere — DB column
 * is `main_model`, header is `X-MMA-Main-Model`).
 *
 * v5 — this used to be a `as unknown as WireTelemetryRecord` passthrough.
 * The translator is now real: the internal record is passed through Zod
 * (`WireTelemetryRecordSchema`) so the wire payload is schema-validated at
 * the egress boundary. When the schema rejects, we fall back to the
 * passthrough to preserve "best-effort telemetry" semantics — but the
 * validation failure is observable on bus emits so backend can detect drift
 * before the warehouse 400s. Callers that need strict validation should
 * call `WireTelemetryRecordSchema.parse` directly.
 */
export function buildWirePayload(
  internalRecord: Record<string, unknown>,
  opts?: { onValidationError?: (err: unknown) => void },
): WireTelemetryRecord {
  const parsed = WireTelemetryRecordSchema.safeParse(internalRecord);
  if (parsed.success) {
    // Schema-strip: drop unknown fields by returning the parsed record. This
    // is the v5 contract guarantee — only wire-schema fields cross the
    // boundary.
    return parsed.data;
  }
  // Schema rejected — surface the error to the caller and fall back to the
  // passthrough so we never silently drop a telemetry row. Backend will
  // 400 on schema mismatch; the bus event makes the drift discoverable
  // before that point.
  opts?.onValidationError?.(parsed.error);
  return internalRecord as unknown as WireTelemetryRecord;
}

function buildStages(
  route: BuildContext['route'],
  rr: RuntimeRunResult,
  gates?: Record<string, StageGate<unknown>>,
  validationWarnings?: Array<{ path: string; rule: string }>,
): StageEntryInternal[] {
  const warnings = validationWarnings ?? [];
  const result: StageEntryInternal[] = [];

  const impl = safeBuild('implementing', () => buildImplStage(rr, gates?.['implement']), warnings);
  if (impl) result.push(impl);

  if (REVIEWED_ROUTES.has(route)) {
    const status = (rr.reviewVerdict as string | undefined) ?? rr.qualityReviewStatus ?? rr.specReviewStatus ?? null;
    const stageRounds = (rr.stageStats?.review as { roundsUsed?: number } | undefined)?.roundsUsed;
    const rounds = stageRounds ?? (Math.max(rr.reviewRounds?.spec ?? 0, rr.reviewRounds?.quality ?? 0) || null);
    const rev = safeBuild('review', () => buildReviewStage(rr, status, rounds, gates?.['review']), warnings);
    if (rev) {
      result.push(rev);
    } else if (QUALITY_ONLY_ROUTES.has(route)) {
      // Read-only routes (audit/review/debug/investigate) hardcode
      // reviewPolicy: 'none' — no LLM reviewer runs. But v5's review stage
      // entry is where findingsBySeverity / concernCategories live, and
      // the implementer IS the finding producer on these routes. Synthesize
      // a zero-metric review stage entry with verdict: 'annotated' (already
      // in the v5 verdict enum precisely for this case) so the wire still
      // carries the per-severity breakdown that the warehouse columns read
      // from stages[?name=review].
      const findings = projectFindings(rr);
      if (findings.length > 0) result.push(buildSyntheticReviewStage(findings));
    }
  }

  if (REVIEWED_ROUTES.has(route) && !QUALITY_ONLY_ROUTES.has(route)) {
    const rw = safeBuild('rework', () => buildReworkStage(rr, gates?.['rework']), warnings);
    if (rw) result.push(rw);
  }

  const an = safeBuild('annotating', () => buildAnnotatingStage(rr, gates?.['annotate']), warnings);
  if (an) result.push(an);

  const cm = safeBuild('committing', () => buildCommitStage(rr, gates?.['commit']), warnings);
  if (cm) result.push(cm);

  return result.slice(0, 8);
}

/**
 * Overlay gate telemetry onto an extracted-stage base. Gates are the v5
 * canonical source for `durationMs`, `costUSD`, `turnsUsed`. When both
 * sources have a value, the gate wins (intentional: the gate is what the
 * lifecycle actually produced; stageStats is the legacy mirror that the
 * runner-shell and per-stage tracker fill in). Tokens, tool calls, and
 * files-read/written remain on stageStats because the gate telemetry block
 * doesn't carry them.
 */
function applyGateOverlay<T extends { durationMs: number; costUSD: number; turnCount: number }>(
  base: T,
  gate: StageGate<unknown> | undefined,
): T {
  if (!gate) return base;
  const t = gate.telemetry;
  return {
    ...base,
    durationMs: clampDurationMsStage(t.durationMs ?? base.durationMs),
    costUSD: clampStageCost(t.costUSD ?? base.costUSD),
    turnCount: clampTurnCount(t.turnsUsed ?? base.turnCount),
  };
}

function extractStageData(
  raw: RawStageStats | RawStageStatsShape | undefined,
  _rr: RuntimeRunResult,
  _stageName: string,
) {
  if (!raw || !raw.entered) return null;
  return {
    model: raw.model ? (normalizeModel(raw.model).canonical ?? raw.model) : null,
    tier: (raw.agentTier as 'standard' | 'complex') ?? 'standard',
    round: (raw as any).round ?? 0,
    durationMs: clampDurationMsStage(raw.durationMs ?? 0),
    costUSD: clampStageCost(raw.costUSD ?? 0),
    inputTokens: clampInputTokens((raw as any).inputTokens ?? 0),
    outputTokens: clampOutputTokens((raw as any).outputTokens ?? 0),
    cachedReadTokens: clampCachedTokens((raw as any).cachedReadTokens ?? 0),
    cachedNonReadTokens: clampCachedTokens((raw as any).cachedNonReadTokens ?? 0),
    toolCallCount: clampToolCallCount((raw as any).toolCallCount ?? 0),
    filesReadCount: clampFilesReadCount((raw as any).filesReadCount ?? 0),
    filesWrittenCount: clampFilesWrittenCount((raw as any).filesWrittenCount ?? 0),
    turnCount: clampTurnCount((raw as any).turnCount ?? 0),
    maxIdleMs: raw.maxIdleMs ?? 0,
    totalIdleMs: raw.totalIdleMs ?? 0,
  };
}

function buildImplStage(rr: RuntimeRunResult, gate?: StageGate<unknown>): StageEntryInternal | null {
  const ss = rr.stageStats?.implementing;
  let base = extractStageData(ss, rr, 'implementing');
  if (!base) return null;
  base = applyGateOverlay(base, gate);
  if (base.model === null) {
    throw new StageModelMissingError('implementing');
  }
  return { name: 'implementing', ...base, model: base.model!, mainEquivalentCostUSD: null, isLlmStage: true } satisfies StageEntryInternal;
}

/** Synthetic review stage entry for read-only routes that hardcode
 *  reviewPolicy: 'none'. The implementer is the finding producer; v5
 *  schema puts findingsBySeverity / concernCategories on the review
 *  stage entry, so this carries them with zero/null operational metrics
 *  (no actual reviewer LLM call happened) and verdict: 'annotated' (a
 *  v5 enum value that means "annotator emitted findings, no quality
 *  verdict reached"). Schema-compliant — no version bump needed. */
function buildSyntheticReviewStage(findings: ProjectedFinding[]): StageEntryInternal {
  const categories = [...new Set(findings.map(f => classifyConcern(f) as ConcernCategoryType))];
  const rawBuckets = bucketFindingsBySeverity(findings.map(f => ({ severity: f.severity })));
  const findingsBySeverity = {
    critical: Math.min(rawBuckets.critical, 200),
    high: Math.min(rawBuckets.high, 200),
    medium: Math.min(rawBuckets.medium, 200),
    low: Math.min(rawBuckets.low, 200),
  };
  return {
    name: 'review',
    model: 'custom',
    tier: 'standard',
    round: 0,
    durationMs: 0,
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
    toolCallCount: 0,
    filesReadCount: 0,
    filesWrittenCount: 0,
    turnCount: 0,
    maxIdleMs: 0,
    totalIdleMs: 0,
    mainEquivalentCostUSD: 0,
    verdict: 'annotated',
    roundsUsed: 1,
    concernCategories: categories.slice(0, 9),
    findingsBySeverity,
    isLlmStage: false,
  } satisfies StageEntryInternal;
}

function buildReviewStage(
  rr: RuntimeRunResult,
  status: string | null,
  rounds: number | null,
  gate?: StageGate<unknown>,
): StageEntryInternal | null {
  const ss = rr.stageStats?.review as RawStageStats | undefined;
  let base = extractStageData(ss, rr, 'review');
  if (!base) return null;
  base = applyGateOverlay(base, gate);
  if (base.model === null) {
    throw new StageModelMissingError('review');
  }

  // v4.4.x: projectFindings reads from structuredReport.findings (read-only
  // routes) and structuredReport.reviewConcerns (reviewed write routes). The
  // pre-v4.4 rr.concerns field is no longer populated by the lifecycle, so
  // reading from there silently produced 0/0/0/0 counts on every wire row.
  const stageConcerns = projectFindings(rr).filter(
    c => c.source === 'spec_review' || c.source === 'quality_review' || c.source === 'review' || c.source === 'implementer',
  );
  const categories = [...new Set(stageConcerns.map(c => classifyConcern(c) as ConcernCategoryType))];
  // 4.0.3+ Gap 2 round-2 F1: use shared bucketFindingsBySeverity helper
  // (separate from headline's countHighOrCritical) so the wire's exact
  // per-bucket counts can't be conflated by accident with the headline's
  // aggregate count. Severity normalization happens inside projectFindings;
  // pass through the already-normalized severity.
  const rawBuckets = bucketFindingsBySeverity(stageConcerns.map(c => ({ severity: c.severity })));
  const findingsBySeverity = {
    critical: Math.min(rawBuckets.critical, 200),
    high: Math.min(rawBuckets.high, 200),
    medium: Math.min(rawBuckets.medium, 200),
    low: Math.min(rawBuckets.low, 200),
  };

  let verdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'annotated' | 'not_applicable' =
    (status as any) ?? 'not_applicable';

  if (verdict === 'approved' && stageConcerns.length > 0) {
    verdict = 'concerns';
  }

  return {
    name: 'review',
    ...base,
    model: base.model!,
    verdict,
    roundsUsed: Math.min(rounds ?? 1, 10),
    concernCategories: categories.slice(0, 9),
    findingsBySeverity,
    mainEquivalentCostUSD: null,
    isLlmStage: true,
  } satisfies StageEntryInternal;
}

function buildReworkStage(rr: RuntimeRunResult, gate?: StageGate<unknown>): StageEntryInternal | null {
  const ss = rr.stageStats?.rework as RawStageStats | undefined;
  let base = extractStageData(ss, rr, 'rework');
  if (!base) return null;
  base = applyGateOverlay(base, gate);
  if (base.model === null) {
    throw new StageModelMissingError('rework');
  }

  const stageConcerns = projectFindings(rr).filter(
    c => c.source === 'spec_review' || c.source === 'quality_review' || c.source === 'review' || c.source === 'implementer',
  );
  const triggeringCategories = [...new Set(stageConcerns.map(c => classifyConcern(c) as ConcernCategoryType))];

  return {
    name: 'rework',
    ...base,
    model: base.model!,
    triggeringConcernCategories: triggeringCategories.slice(0, 9),
    mainEquivalentCostUSD: null,
    isLlmStage: true,
  } satisfies StageEntryInternal;
}

function buildAnnotatingStage(rr: RuntimeRunResult, gate?: StageGate<unknown>): StageEntryInternal | null {
  const ss = rr.stageStats?.annotating as (RawStageStats & { outcome?: string; skipReason?: string }) | undefined;
  let base = extractStageData(ss, rr, 'annotating');
  if (!base) return null;
  base = applyGateOverlay(base, gate);

  // Annotator is an LLM stage iff the runtime actually invoked a model.
  // Per spec §4.1.3, the observable signal is whether stageStats.annotating.model
  // was populated. Task A6 fixes the upstream so this is always populated when
  // the LLM was called. When null (degraded pure-transform path), the stage
  // appears in wire stages[] but is excluded from tier rollup.
  const isLlmStage = base.model !== null && base.model !== 'custom';

  return {
    name: 'annotating',
    ...base,
    model: base.model || 'custom',
    isLlmStage,
    mainEquivalentCostUSD: null,
    outcome: (ss?.outcome as 'passed' | 'failed' | 'skipped' | 'not_applicable' | 'transformed' | undefined) ?? 'not_applicable',
    skipReason: ss?.outcome === 'skipped' ? ((ss?.skipReason as 'no_command' | 'dirty_worktree' | 'not_applicable' | 'other' | undefined) ?? 'other') : null,
  } satisfies StageEntryInternal;
}

function buildCommitStage(rr: RuntimeRunResult, gate?: StageGate<unknown>): StageEntryInternal | null {
  const ss = rr.stageStats?.committing;
  let base = extractStageData(ss, rr, 'committing');
  if (!base) return null;
  base = applyGateOverlay(base, gate);

  const commits = Array.isArray(rr.commits) ? rr.commits : [];
  const allFiles = commits.flatMap((c) =>
    Array.isArray(c?.filesChanged)
      ? c.filesChanged.filter((f: unknown): f is string => typeof f === 'string')
      : []
  );
  const filesCommittedCount = Math.min(new Set(allFiles).size, 1000);

  return {
    name: 'committing',
    ...base,
    model: base.model || 'custom',
    filesCommittedCount,
    // CommitStageRunner does not track branch-creation directly today;
    // name-diff against pre-commit refs is unreliable, so we report
    // false. A future change can wire this when CommitStageRunner emits
    // an explicit signal alongside filesCommittedCount.
    branchCreated: false,
    mainEquivalentCostUSD: null,
    isLlmStage: false,
  } satisfies StageEntryInternal;
}

// ── Derivation helpers ─────────────────────────────────────────────────────

function deriveTerminalStatus(rr: RuntimeRunResult): TaskCompletedEventType['terminalStatus'] {
  const tr = rr.terminationReason;
  if (!tr || typeof tr !== 'object') return 'incomplete';
  switch (tr.cause) {
    case 'finished': return 'ok';
    case 'incomplete':
    case 'degenerate_exhausted': return 'incomplete';
    case 'timeout': return 'timeout';
    case 'cost_exceeded': return 'cost_exceeded';
    case 'brief_too_vague': return 'brief_too_vague';
    case 'api_error':
    case 'provider_transport_failure':
    case 'api_aborted':
    case 'error': return 'error';
    default: return 'incomplete';
  }
}

const VALID_ERROR_CODES: ReadonlySet<string> = new Set(ErrorCode.options);

function deriveErrorCode(rr: RuntimeRunResult): TaskCompletedEventType['errorCode'] {
  // structuredError.code is the most authoritative signal — the lifecycle
  // sets it for specific failure modes.
  if (rr.structuredError?.code) {
    const code = rr.structuredError.code;
    if (VALID_ERROR_CODES.has(code)) return code as TaskCompletedEventType['errorCode'];
    return null;
  }
  // rr.errorCode carries intentional error codes set by the lifecycle
  // (e.g., 'validator_silent_incomplete'). Status-level fallbacks from the
  // delegation layer (e.g., 'incomplete', 'error', 'timeout') are NOT
  // valid telemetry error codes and are dropped here.
  if (rr.errorCode && VALID_ERROR_CODES.has(rr.errorCode)) {
    return rr.errorCode as TaskCompletedEventType['errorCode'];
  }
  const tr = rr.terminationReason;
  if (tr && typeof tr === 'object') {
    switch (tr.cause) {
      case 'api_error':
      case 'api_aborted': return 'provider_api_error';
      case 'provider_transport_failure': return 'provider_transport_failure';
    }
  }
  return null;
}

function deriveWorkerStatus(rr: RuntimeRunResult): TaskCompletedEventType['workerStatus'] {
  const tr = rr.terminationReason;
  if (tr && typeof tr === 'object' && tr.cause === 'finished' && tr.workerSelfAssessment) {
    return tr.workerSelfAssessment as any;
  }
  if (rr.workerStatus) return rr.workerStatus as any;
  return 'failed';
}
