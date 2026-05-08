import { randomUUID } from 'node:crypto';
import type { RunResult, RawStageStats } from '../types.js';
import { normalizeModel } from './normalize.js';
import { classifyConcern } from './concern-classifier.js';
import { ErrorCode, type TaskCompletedEventType, type StageEntryType, type ConcernCategoryType, type WireTelemetryRecord } from './telemetry-types.js';

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

export interface BuildContext {
  route: 'delegate' | 'audit' | 'review' | 'verify' | 'debug' | 'execute-plan' | 'retry' | 'investigate' | 'register-context-block';
  taskSpec: { filePaths?: string[] };
  runResult: RunResult;
  client: string;
  mainModel: string | null;
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
  verifyCommandPresent?: boolean;
}

const REVIEWED_ROUTES = new Set(['delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'investigate']);
const QUALITY_ONLY_ROUTES = new Set(['audit', 'review', 'verify', 'debug', 'investigate']);
const VERIFY_ROUTES = new Set(['delegate', 'execute-plan', 'verify']);

export function buildTaskCompletedEvent(ctx: BuildContext): WireTelemetryRecord {
  const { route, runResult, client, mainModel } = ctx;

  const stages = buildStages(route, runResult);

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
  const tierUsage = rollupByTier(stages.map(s => ({
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

  const mainCard = resolveRateCard(mainModel);
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

  const internalRecord = {
    eventId: randomUUID(),
    route,
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
    concernCount: Math.min(runResult.concerns?.length ?? 0, 150),
    escalationCount,
    fallbackCount: Math.min(runResult.agents?.fallbackOverrides?.length ?? 0, 20),
    stallCount: Math.min(runResult.stallCount ?? (runResult.stallTriggered ? 1 : 0), 20),
    taskMaxIdleMs: runResult.taskMaxIdleMs ?? 0,
    sandboxViolationCount: Math.min((runResult as any).sandboxViolationCount ?? 0, 100),
    stages,
  };

  return buildWirePayload(internalRecord);
}

/**
 * Wire payload builder. Internal record fields match the wire schema 1:1
 * after the v4.0.3 rename (mainModel/mainModelFamily everywhere — DB column
 * is `main_model`, header is `X-MMA-Main-Model`, no more `mainModel`
 * translation shim).
 */
export function buildWirePayload(internalRecord: Record<string, unknown>): WireTelemetryRecord {
  return internalRecord as unknown as WireTelemetryRecord;
}

function buildStages(route: BuildContext['route'], rr: RunResult): StageEntryType[] {
  const result: StageEntryType[] = [];

  // implementing — always present
  const impl = buildImplStage(rr);
  if (impl) result.push(impl);

  // spec_review — only on reviewed routes with full review
  if (REVIEWED_ROUTES.has(route) && !QUALITY_ONLY_ROUTES.has(route)) {
    const sr = buildReviewStage('spec_review', rr, rr.specReviewStatus ?? null, rr.reviewRounds?.spec ?? null);
    if (sr) result.push(sr);
  }

  // spec_rework — only on full review routes
  if (REVIEWED_ROUTES.has(route) && !QUALITY_ONLY_ROUTES.has(route)) {
    const sw = buildReworkStage('spec_rework', rr);
    if (sw) result.push(sw);
  }

  // quality_review — on all reviewed routes
  if (REVIEWED_ROUTES.has(route)) {
    const qr = buildReviewStage('quality_review', rr, rr.qualityReviewStatus ?? null, rr.reviewRounds?.quality ?? null);
    if (qr) result.push(qr);
  }

  // quality_rework — on all reviewed routes
  if (REVIEWED_ROUTES.has(route)) {
    const qw = buildReworkStage('quality_rework', rr);
    if (qw) result.push(qw);
  }

  // diff_review — only on full review routes. Diff review is a single-pass
  // gate (no rework loop), so use one valid round when the stage was entered;
  // reviewRounds.metadata tracks commit metadata repair attempts, not diff
  // review rounds.
  if (REVIEWED_ROUTES.has(route) && !QUALITY_ONLY_ROUTES.has(route)) {
    const dr = buildReviewStage('diff_review', rr, rr.diffReviewStatus ?? null, 1);
    if (dr) result.push(dr);
  }

  // verifying — only on delegate, execute-plan, verify routes
  if (VERIFY_ROUTES.has(route)) {
    const vs = buildVerifyStage(rr);
    if (vs) result.push(vs);
  }

  // committing — always present
  const cm = buildCommitStage(rr);
  if (cm) result.push(cm);

  return result.slice(0, 8);
}

function extractStageData(
  raw: RawStageStats | undefined,
  _rr: RunResult,
  _stageName: string,
) {
  if (!raw || !raw.entered) return null;
  return {
    model: raw.model ? normalizeModel(raw.model).canonical ?? raw.model : 'custom',
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

function buildImplStage(rr: RunResult): StageEntryType | null {
  const ss = rr.stageStats?.implementing;
  const base = extractStageData(ss, rr, 'implementing');
  if (!base) return null;
  return { name: 'implementing', ...base } as StageEntryType;
}

function buildReviewStage(
  name: 'spec_review' | 'quality_review' | 'diff_review',
  rr: RunResult,
  status: string | null,
  rounds: number | null,
): StageEntryType | null {
  const ss = rr.stageStats?.[name] as RawStageStats | undefined;
  const base = extractStageData(ss, rr, name);
  if (!base) return null;

  const concernSource = name;
  const stageConcerns = (rr.concerns ?? []).filter(c => c.source === concernSource);
  const categories = [...new Set(stageConcerns.map(c => classifyConcern(c) as ConcernCategoryType))];
  const findingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of stageConcerns) {
    const sev = (c as any).severity ?? 'medium';
    if (sev in findingsBySeverity) {
      findingsBySeverity[sev as keyof typeof findingsBySeverity] =
        Math.min(findingsBySeverity[sev as keyof typeof findingsBySeverity] + 1, 200);
    }
  }

  let verdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'annotated' | 'not_applicable' =
    (status as any) ?? 'not_applicable';

  if (verdict === 'approved' && stageConcerns.length > 0) {
    verdict = 'concerns';
  }

  return {
    name,
    ...base,
    verdict,
    roundsUsed: Math.min(rounds ?? 1, 10),
    concernCategories: categories.slice(0, 9),
    findingsBySeverity,
  } as StageEntryType;
}

function buildReworkStage(
  name: 'spec_rework' | 'quality_rework',
  rr: RunResult,
): StageEntryType | null {
  const ss = rr.stageStats?.[name] as RawStageStats | undefined;
  const base = extractStageData(ss, rr, name);
  if (!base) return null;

  const concernSource = name === 'spec_rework' ? 'spec_review' : 'quality_review';
  const stageConcerns = (rr.concerns ?? []).filter(c => c.source === concernSource);
  const triggeringCategories = [...new Set(stageConcerns.map(c => classifyConcern(c) as ConcernCategoryType))];

  return {
    name,
    ...base,
    triggeringConcernCategories: triggeringCategories.slice(0, 9),
  } as StageEntryType;
}

function buildVerifyStage(rr: RunResult): StageEntryType | null {
  const ss = rr.stageStats?.verifying as (RawStageStats & { outcome?: string; skipReason?: string }) | undefined;
  const base = extractStageData(ss, rr, 'verifying');
  if (!base) return null;

  return {
    name: 'verifying',
    ...base,
    outcome: (ss?.outcome as any) ?? 'not_applicable',
    skipReason: ss?.outcome === 'skipped' ? ((ss?.skipReason as any) ?? 'other') : null,
  } as StageEntryType;
}

function buildCommitStage(rr: RunResult): StageEntryType | null {
  const ss = rr.stageStats?.committing;
  const base = extractStageData(ss, rr, 'committing');
  if (!base) return null;

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
    filesCommittedCount,
    // CommitStageRunner does not track branch-creation directly today;
    // name-diff against pre-commit refs is unreliable, so we report
    // false. A future change can wire this when CommitStageRunner emits
    // an explicit signal alongside filesCommittedCount.
    branchCreated: false,
  } as StageEntryType;
}

// ── Derivation helpers ─────────────────────────────────────────────────────

function deriveTerminalStatus(rr: RunResult): TaskCompletedEventType['terminalStatus'] {
  const tr = rr.terminationReason;
  if (tr === 'all_tiers_unavailable') return 'unavailable';
  if (tr === 'cost_ceiling') return 'cost_exceeded';
  if (tr === 'round_cap') return 'incomplete';
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

function deriveErrorCode(rr: RunResult): TaskCompletedEventType['errorCode'] {
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

function deriveWorkerStatus(rr: RunResult): TaskCompletedEventType['workerStatus'] {
  const tr = rr.terminationReason;
  if (tr && typeof tr === 'object' && tr.cause === 'finished' && tr.workerSelfAssessment) {
    return tr.workerSelfAssessment as any;
  }
  if (rr.workerStatus) return rr.workerStatus as any;
  return 'failed';
}
