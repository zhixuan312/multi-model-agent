import { randomUUID } from 'node:crypto';
import type {
  RunResult,
  RawStageStats,
} from '../types.js';
import { computeSavedCostUSD } from '../types.js';
import { extractCanonicalModelName } from '../routing/model-profiles.js';
import {
  bucketCost,
  bucketSavedCost,
  bucketDuration,
  bucketFileCount,
  bucketRoundsUsed,
  bucketTurnCount,
} from './bucketing.js';
import { classifyConcern } from './concern-classifier.js';
import { BoundedIdentifier } from './types.js';
import type {
  TelemetryEventType,
  TaskCompletedEventType,
  SkillInstalledEventType,
  ErrorCodeType,
  ModelFamilyType,
} from './types.js';

const KNOWN_CAPABILITIES = new Set(['web_search', 'web_fetch']);

// ── Public surface ────────────────────────────────────────────────────────

export interface BuildContext {
  route: 'delegate' | 'audit' | 'review' | 'verify' | 'debug' | 'execute-plan' | 'retry';
  taskSpec: { filePaths?: string[] };
  runResult: RunResult;
  client: string;
  triggeringSkill: string;
  parentModel: string | null;
}

export interface SessionSnapshot {
  defaultTier: 'standard' | 'complex';
  diagnosticsEnabled: boolean;
  autoUpdateSkills: boolean;
  providersConfigured: Array<'claude' | 'openai-compatible' | 'codex'>;
}

export function buildTaskCompletedEvent(ctx: BuildContext): TelemetryEventType {
  const { route, taskSpec, runResult, client, triggeringSkill, parentModel } = ctx;

  const terminalStatus = deriveTerminalStatus(runResult);
  // errorCode is set only when there's a *real* failure to attribute. R1 forbids
  // it on `ok`. For `error` we derive from structuredError + terminationReason.
  // For `incomplete` / `timeout` / `cost_exceeded` / `brief_too_vague` /
  // `unavailable` — these are non-success outcomes but not error categories;
  // leave null unless the runner attached an explicit structured code. Avoids
  // the lazy `'other'` fallback that pollutes failure-mode panels.
  const errorCode = (() => {
    if (terminalStatus === 'ok')    return null;
    if (terminalStatus === 'error') return deriveErrorCode(runResult);
    if (runResult.structuredError?.code) {
      return runResult.structuredError.code as ErrorCodeType;
    }
    return null;
  })();
  const workerStatus = deriveWorkerStatus(runResult);
  const escalated = (runResult.escalationLog?.length ?? 0) > 1;
  const fallbackTriggered = (runResult.agents?.fallbackOverrides?.length ?? 0) > 0;

  const costBucketVal = bucketCost(runResult.usage?.costUSD ?? 0);
  const durationBucketVal = bucketDuration(runResult.durationMs ?? 0);
  const fileCountBucketVal = bucketFileCount(taskSpec.filePaths?.length ?? 0);

  const savedCostUSDRaw = computeSavedCostUSD(
    runResult.usage?.costUSD ?? null,
    runResult.usage?.inputTokens ?? 0,
    runResult.usage?.outputTokens ?? 0,
    parentModel ?? undefined,
  );
  const savedCostBucketVal = bucketSavedCost(savedCostUSDRaw);

  const implModelRaw = runResult.models?.implementer ?? null;
  const implModel = implModelRaw ? extractCanonicalModelName(implModelRaw) : null;
  const implementerModelFamily = deriveModelFamily(implModel);
  const implementerModel = normalizeModelForTelemetry(implModel);

  const agentType = runResult.agents?.implementer === 'complex' ? 'complex' as const : 'standard' as const;
  const rawCapabilities = runResult.agents?.implementerCapabilities ?? [];
const capabilities = rawCapabilities.map(c => KNOWN_CAPABILITIES.has(c) ? c : 'other');
  const toolMode = (runResult.agents?.implementerToolMode ?? 'full') as 'none' | 'readonly' | 'no-shell' | 'full';

  const topToolNames = deriveTopToolNames(runResult.toolCalls ?? []);

  const stages = buildStages(route, runResult);

  // v2 fields
  const tr = runResult.terminationReason;
  const trIsObject = tr && typeof tr === 'object';
  const escalationLog = runResult.escalationLog ?? [];
  const distinctProviders = new Set(escalationLog.map(a => a.provider)).size;
  const escalationCount = Math.max(0, distinctProviders - 1);

  return {
    type: 'task.completed',
    eventId: randomUUID(),
    route,
    agentType,
    capabilities: [...new Set(capabilities.filter(c => c === 'web_search' || c === 'web_fetch' || c === 'other'))],
    toolMode,
    triggeredFromSkill: triggeringSkill,
    client,
    fileCountBucket: fileCountBucketVal,
    durationBucket: durationBucketVal,
    costBucket: costBucketVal,
    savedCostBucket: savedCostBucketVal,
    implementerModelFamily,
    implementerModel,
    terminalStatus,
    workerStatus,
    errorCode,
    escalated,
    fallbackTriggered,
    topToolNames,
    stages,
    // v2 fields
    filesWrittenBucket: bucketFileCount(runResult.filesWritten.length),
    c2Promoted: trIsObject ? (tr.wasPromoted ?? false) : false,
    workerSelfAssessment: trIsObject ? (tr.workerSelfAssessment ?? null) : null,
    concernCount: runResult.concerns?.length ?? 0,
    escalationCount,
    fallbackCount: runResult.agents?.fallbackOverrides?.length ?? 0,
    turnCountBucket: bucketTurnCount(runResult.turns),
    stallTriggered: runResult.stallTriggered ?? false,
    clarificationRequested: runResult.lifecycleClarificationRequested ?? false,
    parentModelFamily: deriveModelFamily(parentModel),
    briefQualityWarningCount: runResult.briefQualityWarnings?.length ?? 0,
  } as TelemetryEventType;
}

export function buildSessionStartedEvent(snapshot: SessionSnapshot): TelemetryEventType {
  return {
    type: 'session.started',
    eventId: randomUUID(),
    configFlavor: {
      defaultTier: snapshot.defaultTier,
      diagnosticsEnabled: snapshot.diagnosticsEnabled,
      autoUpdateSkills: snapshot.autoUpdateSkills,
    },
    providersConfigured: [...new Set(snapshot.providersConfigured)],
  } as TelemetryEventType;
}

export function buildInstallChangedEvent(
  from: string | null,
  to: string,
  trigger: 'fresh_install' | 'upgrade' | 'downgrade',
): TelemetryEventType {
  return {
    type: 'install.changed',
    eventId: randomUUID(),
    fromVersion: from,
    toVersion: to,
    trigger,
  } as TelemetryEventType;
}

export function buildSkillInstalledEvent(
  skillId: string,
  client: string,
): TelemetryEventType {
  return {
    type: 'skill.installed',
    eventId: randomUUID(),
    skill: skillId as SkillInstalledEventType['skill'],
    client: client as SkillInstalledEventType['client'],
  } as TelemetryEventType;
}

// ── Derivation helpers ─────────────────────────────────────────────────────

function deriveTerminalStatus(rr: RunResult): TaskCompletedEventType['terminalStatus'] {
  const tr = rr.terminationReason;

  // Top-level string literals (handled before any property access)
  if (tr === 'all_tiers_unavailable') return 'unavailable';
  if (tr === 'cost_ceiling') return 'cost_exceeded';
  if (tr === 'round_cap') return 'incomplete';

  // Missing terminationReason
  if (!tr || typeof tr !== 'object') return 'incomplete';

  // Object form — read cause
  switch (tr.cause) {
    case 'finished':           return 'ok';
    case 'incomplete':
    case 'degenerate_exhausted': return 'incomplete';
    case 'timeout':            return 'timeout';
    case 'cost_exceeded':      return 'cost_exceeded';
    case 'brief_too_vague':    return 'brief_too_vague';
    case 'api_error':
    case 'network_error':
    case 'api_aborted':
    case 'error':              return 'error';
    default:                   return 'incomplete';
  }
}

function deriveErrorCode(rr: RunResult): ErrorCodeType {
  // Priority 1: structuredError.code if present and in allowlist
  if (rr.structuredError?.code) {
    return rr.structuredError.code as ErrorCodeType;
  }

  // Priority 2: from terminationReason.cause mapping
  const tr = rr.terminationReason;
  if (tr && typeof tr === 'object') {
    switch (tr.cause) {
      case 'api_error':       return 'api_error';
      case 'network_error':   return 'network_error';
      case 'api_aborted':     return 'api_error';
    }
  }

  // Priority 3: fallback
  return 'other';
}

function deriveWorkerStatus(rr: RunResult): TaskCompletedEventType['workerStatus'] {
  const tr = rr.terminationReason;

  // Priority 1: terminationReason.cause === 'finished' → use workerSelfAssessment
  if (tr && typeof tr === 'object' && tr.cause === 'finished' && tr.workerSelfAssessment) {
    return tr.workerSelfAssessment;
  }

  // Priority 2: RunResult.workerStatus
  if (rr.workerStatus) return rr.workerStatus;

  // Priority 3: fallback
  return 'failed';
}

const SNAKE_TO_CAMEL: Record<string, string> = {
  read_file: 'readFile',
  write_file: 'writeFile',
  edit_file: 'editFile',
  run_shell: 'runShell',
  list_files: 'listFiles',
};

/**
 * Top-N selection of tool names by call frequency.
 * Pipeline:
 *   1. snake_case → camelCase normalization (so adapters emitting either form
 *      collapse to the same tool name in counts)
 *   2. shape validation against BoundedIdentifier (any name that passes is
 *      counted; names that fail shape are dropped — NOT collapsed to 'other')
 *   3. top 20 by frequency (matches schema max(20))
 */
export function deriveTopToolNames(toolCalls: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of toolCalls) {
    const canonical = SNAKE_TO_CAMEL[name] ?? name;
    if (BoundedIdentifier.safeParse(canonical).success) {
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name]) => name);
}

function buildStages(
  route: BuildContext['route'],
  rr: RunResult,
): TaskCompletedEventType['stages'] {
  const ss = rr.stageStats;
  const reviewedRoutes = new Set(['delegate', 'execute-plan']);
  const verifyRoutes = new Set(['delegate', 'execute-plan', 'verify']);

  return {
    implementing: buildStageStats(ss?.implementing),
    verifying: buildVerifyStageStats(ss?.verifying, route, verifyRoutes),
    spec_review: buildReviewStageStats(
      ss?.spec_review,
      route,
      reviewedRoutes,
      'spec_review',
      rr.specReviewStatus ?? null,
      rr.reviewRounds?.spec ?? null,
      rr,
    ),
    spec_rework: buildStageStats(ss?.spec_rework),
    quality_review: buildReviewStageStats(
      ss?.quality_review,
      route,
      reviewedRoutes,
      'quality_review',
      rr.qualityReviewStatus ?? null,
      rr.reviewRounds?.quality ?? null,
      rr,
    ),
    quality_rework: buildStageStats(ss?.quality_rework),
    diff_review: reviewedRoutes.has(route) && ss?.diff_review && (ss.diff_review as RawStageStats).entered
      ? buildReviewStageStats(
          ss?.diff_review,
          route,
          reviewedRoutes,
          'diff_review',
          null,
          null,
          rr,
        )
      : undefined,
    committing: buildStageStats(ss?.committing),
  };
}

function buildStageStats(raw: RawStageStats | undefined): {
  entered: boolean;
  durationBucket: '<10s' | '10s-1m' | '1m-5m' | '5m-30m' | '30m+' | null;
  costBucket: '$0' | '<$0.01' | '$0.01-$0.10' | '$0.10-$1' | '$1+' | null;
  agentTier: 'standard' | 'complex' | null;
  modelFamily: ModelFamilyType | null;
  model: string | null;
} {
  if (!raw || !raw.entered) {
    return {
      entered: false,
      durationBucket: null,
      costBucket: null,
      agentTier: null,
      modelFamily: null,
      model: null,
    };
  }

  return {
    entered: true,
    durationBucket: bucketDuration(raw.durationMs ?? 0),
    costBucket: bucketCost(raw.costUSD ?? 0),
    agentTier: raw.agentTier,
    modelFamily: raw.modelFamily as ModelFamilyType | null,
    model: normalizeModelForTelemetry(raw.model ? extractCanonicalModelName(raw.model) : null),
  };
}

function buildVerifyStageStats(
  raw: Extract<RawStageStats, { stage: 'verifying' }> | undefined,
  route: BuildContext['route'],
  verifyRoutes: Set<string>,
): TaskCompletedEventType['stages']['verifying'] {
  if (!verifyRoutes.has(route)) {
    return {
      entered: false,
      durationBucket: null,
      costBucket: null,
      agentTier: null,
      modelFamily: null,
      model: null,
      outcome: null,
      skipReason: null,
    };
  }

  if (!raw || !raw.entered) {
    return {
      entered: false,
      durationBucket: null,
      costBucket: null,
      agentTier: null,
      modelFamily: null,
      model: null,
      outcome: null,
      skipReason: null,
    };
  }

  return {
    entered: true,
    durationBucket: bucketDuration(raw.durationMs ?? 0),
    costBucket: bucketCost(raw.costUSD ?? 0),
    agentTier: raw.agentTier,
    modelFamily: raw.modelFamily as ModelFamilyType | null,
    model: normalizeModelForTelemetry(raw.model ? extractCanonicalModelName(raw.model) : null),
    outcome: raw.outcome ?? 'not_applicable',
    skipReason: raw.outcome === 'skipped' ? (raw.skipReason ?? 'other') : null,
  };
}

function buildReviewStageStats(
  raw: Extract<RawStageStats, { stage: 'spec_review' | 'quality_review' | 'diff_review' }> | undefined,
  route: BuildContext['route'],
  reviewedRoutes: Set<string>,
  concernSource: 'spec_review' | 'quality_review' | 'diff_review',
  reviewStatus: string | null,
  rounds: number | null,
  rr: RunResult,
): {
  entered: boolean;
  durationBucket: '<10s' | '10s-1m' | '1m-5m' | '5m-30m' | '30m+' | null;
  costBucket: '$0' | '<$0.01' | '$0.01-$0.10' | '$0.10-$1' | '$1+' | null;
  agentTier: 'standard' | 'complex' | null;
  modelFamily: ModelFamilyType | null;
  model: string | null;
  verdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'not_applicable' | null;
  roundsUsed: '0' | '1' | '2+' | null;
  concernCategories: Array<'missing_test' | 'scope_creep' | 'incomplete_impl' | 'style_lint' | 'security' | 'performance' | 'maintainability' | 'doc_gap' | 'other'> | null;
} {
  if (!reviewedRoutes.has(route)) {
    return {
      entered: false,
      durationBucket: null,
      costBucket: null,
      agentTier: null,
      modelFamily: null,
      model: null,
      verdict: null,
      roundsUsed: null,
      concernCategories: null,
    };
  }

  if (!raw || !raw.entered) {
    return {
      entered: false,
      durationBucket: null,
      costBucket: null,
      agentTier: null,
      modelFamily: null,
      model: null,
      verdict: null,
      roundsUsed: null,
      concernCategories: null,
    };
  }

  // Derive verdict: upgrade 'approved' → 'concerns' if concerns exist from this stage
  let verdict: 'approved' | 'concerns' | 'changes_required' | 'error' | 'skipped' | 'not_applicable' | null =
    (reviewStatus as 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable' | null) ?? 'not_applicable';

  if (verdict === 'approved') {
    const hasMatchingConcerns = (rr.concerns ?? []).some(c => c.source === concernSource);
    if (hasMatchingConcerns) {
      verdict = 'concerns';
    }
  }

  // Classify concerns for this stage
  const stageConcerns = (rr.concerns ?? []).filter(c => c.source === concernSource);
  const categories = [...new Set(stageConcerns.map(c => classifyConcern(c)))];

  return {
    entered: true,
    durationBucket: bucketDuration(raw.durationMs ?? 0),
    costBucket: bucketCost(raw.costUSD ?? 0),
    agentTier: raw.agentTier,
    modelFamily: raw.modelFamily as ModelFamilyType | null,
    model: normalizeModelForTelemetry(raw.model ? extractCanonicalModelName(raw.model) : null),
    verdict,
    roundsUsed: rounds !== null ? bucketRoundsUsed(rounds) : '1',
    concernCategories: categories.length > 0 ? categories : [],
  };
}

// ── Model helpers ──────────────────────────────────────────────────────────

export function deriveModelFamily(modelId: string | null | undefined): ModelFamilyType {
  if (!modelId) return 'other';
  const m = modelId.toLowerCase();
  if (m.startsWith('claude'))                                              return 'claude';
  if (
    m.startsWith('gpt')      ||
    m.startsWith('openai')   ||
    m.startsWith('o1')       ||
    m.startsWith('o3')       ||
    m.startsWith('o4')
  )                                                                        return 'openai';
  if (m.startsWith('gemini'))                                              return 'gemini';
  if (m.startsWith('deepseek'))                                            return 'deepseek';
  if (m.startsWith('grok'))                                                return 'grok';
  if (m.startsWith('mistral'))                                             return 'mistral';
  if (m.startsWith('llama') || m.startsWith('meta-llama/'))                return 'meta';
  if (m.startsWith('qwen'))                                                return 'qwen';
  if (m.startsWith('glm'))                                                 return 'zhipu';
  if (m.startsWith('kimi'))                                                return 'kimi';
  if (m.startsWith('minimax'))                                             return 'minimax';
  return 'other';
}

export function normalizeModelForTelemetry(modelId: string | null | undefined): string {
  if (!modelId) return 'other';
  const result = BoundedIdentifier.safeParse(modelId);
  return result.success ? modelId : 'other';
}
