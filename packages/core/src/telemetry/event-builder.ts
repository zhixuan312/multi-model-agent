import { randomUUID } from 'node:crypto';
import type { RunResult, RawStageStats } from '../types.js';
import { computeSavedCostUSD } from '../types.js';
import { normalizeModel } from './normalize.js';
import { classifyConcern } from './concern-classifier.js';
import type { TaskCompletedEventType, StageEntryType, ConcernCategoryType } from './types.js';

const KNOWN_CAPABILITIES = new Set(['web_search', 'web_fetch']);

export interface BuildContext {
  route: 'delegate' | 'audit' | 'review' | 'verify' | 'debug' | 'execute-plan' | 'retry';
  taskSpec: { filePaths?: string[] };
  runResult: RunResult;
  client: string;
  parentModel: string | null;
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
  verifyCommandPresent?: boolean;
}

const REVIEWED_ROUTES = new Set(['delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'investigate']);
const QUALITY_ONLY_ROUTES = new Set(['audit', 'review', 'verify', 'debug', 'investigate']);
const VERIFY_ROUTES = new Set(['delegate', 'execute-plan', 'verify']);

export function buildTaskCompletedEvent(ctx: BuildContext): TaskCompletedEventType {
  const { route, runResult, client, parentModel } = ctx;

  const stages = buildStages(route, runResult);

  // Token sums across stages
  const tokenSums = stages.reduce(
    (acc, s) => ({
      input: acc.input + s.inputTokens,
      output: acc.output + s.outputTokens,
      cached: acc.cached + s.cachedTokens,
      reasoning: acc.reasoning + s.reasoningTokens,
    }),
    { input: 0, output: 0, cached: 0, reasoning: 0 },
  );

  // Cost sums
  const totalCostUSD = stages.reduce((s, st) => s + st.costUSD, 0);
  const totalDurationMs = stages.reduce((s, st) => s + st.durationMs, 0);

  const savedCostUSD = computeSavedCostUSD(
    runResult.usage?.costUSD ?? null,
    runResult.usage?.inputTokens ?? 0,
    runResult.usage?.outputTokens ?? 0,
    parentModel ?? undefined,
  );

  const reviewPolicy = ctx.reviewPolicy ?? (QUALITY_ONLY_ROUTES.has(route) ? 'quality_only' : 'full');
  const verifyCommandPresent = ctx.verifyCommandPresent ?? false;

  const implModelRaw = runResult.models?.implementer ?? null;
  const implResult = implModelRaw ? normalizeModel(implModelRaw) : null;

  const escalationLog = runResult.escalationLog ?? [];
  const distinctProviders = new Set(escalationLog.map(a => a.provider)).size;
  const escalationCount = Math.max(0, distinctProviders - 1);

  return {
    eventId: randomUUID(),
    route,
    client,
    agentType: runResult.agents?.implementer === 'complex' ? 'complex' : 'standard',
    toolMode: (runResult.agents?.implementerToolMode ?? 'full') as 'none' | 'readonly' | 'no-shell' | 'full',
    capabilities: (runResult.agents?.implementerCapabilities ?? [])
      .filter(c => KNOWN_CAPABILITIES.has(c))
      .slice(0, 3) as Array<'web_search' | 'web_fetch'>,
    reviewPolicy,
    verifyCommandPresent,
    implementerModel: implResult?.canonical ?? 'custom',
    terminalStatus: deriveTerminalStatus(runResult),
    workerStatus: deriveWorkerStatus(runResult),
    errorCode: deriveErrorCode(runResult),
    parentModelFamily: parentModel ? normalizeModel(parentModel).family : 'other',
    inputTokens: tokenSums.input,
    outputTokens: tokenSums.output,
    cachedTokens: tokenSums.cached,
    reasoningTokens: tokenSums.reasoning,
    totalDurationMs,
    totalCostUSD,
    totalSavedCostUSD: savedCostUSD,
    concernCount: Math.min(runResult.concerns?.length ?? 0, 150),
    escalationCount,
    fallbackCount: Math.min(runResult.agents?.fallbackOverrides?.length ?? 0, 20),
    stallCount: Math.min(runResult.stallCount ?? (runResult.stallTriggered ? 1 : 0), 20),
    taskMaxIdleMs: runResult.taskMaxIdleMs ?? null,
    clarificationRequested: runResult.lifecycleClarificationRequested ?? false,
    briefQualityWarningCount: Math.min(runResult.briefQualityWarnings?.length ?? 0, 20),
    sandboxViolationCount: Math.min((runResult as any).sandboxViolationCount ?? 0, 100),
    stages,
  };
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

  // diff_review — only on full review routes
  if (REVIEWED_ROUTES.has(route) && !QUALITY_ONLY_ROUTES.has(route)) {
    const dr = buildReviewStage('diff_review', rr, null, null);
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

function extractStageData(raw: RawStageStats | undefined) {
  if (!raw || !raw.entered) return null;
  return {
    model: raw.model ? normalizeModel(raw.model).canonical : 'custom',
    agentTier: (raw.agentTier === 'complex' ? 'reasoning' : 'standard') as 'standard' | 'reasoning',
    durationMs: Math.min(raw.durationMs ?? 0, 3_600_000),
    costUSD: Math.round((raw.costUSD ?? 0) * 1_000_000) / 1_000_000,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    toolCallCount: 0,
    filesReadCount: 0,
    filesWrittenCount: 0,
    turnCount: 0,
    maxIdleMs: raw.maxIdleMs ?? null,
    totalIdleMs: raw.totalIdleMs ?? null,
  };
}

function buildImplStage(rr: RunResult): StageEntryType | null {
  const ss = rr.stageStats?.implementing;
  const base = extractStageData(ss);
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
  const base = extractStageData(ss);
  if (!base) return null;

  const concernSource = name;
  const stageConcerns = (rr.concerns ?? []).filter(c => c.source === concernSource);
  const categories = [...new Set(stageConcerns.map(c => classifyConcern(c) as ConcernCategoryType))];
  const findingsBySeverity = { high: 0, medium: 0, low: 0, style: 0 };
  for (const c of stageConcerns) {
    const sev = (c as any).severity ?? 'medium';
    if (sev in findingsBySeverity) {
      findingsBySeverity[sev as keyof typeof findingsBySeverity] =
        Math.min(findingsBySeverity[sev as keyof typeof findingsBySeverity] + 1, 50);
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
  const base = extractStageData(ss);
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
  const base = extractStageData(ss);
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
  const base = extractStageData(ss);
  if (!base) return null;

  return {
    name: 'committing',
    ...base,
    filesCommittedCount: 0,
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
    case 'network_error':
    case 'api_aborted':
    case 'error': return 'error';
    default: return 'incomplete';
  }
}

function deriveErrorCode(rr: RunResult): TaskCompletedEventType['errorCode'] {
  if (rr.structuredError?.code) return rr.structuredError.code as any;
  const tr = rr.terminationReason;
  if (tr && typeof tr === 'object') {
    switch (tr.cause) {
      case 'api_error':
      case 'api_aborted': return 'api_error';
      case 'network_error': return 'network_error';
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
