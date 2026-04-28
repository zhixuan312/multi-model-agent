import type {
  AttemptRecord,
  RunOptions,
  RunStatus,
  TerminationReason,
  TokenUsage,
} from './runners/types.js';
import type { BriefQualityPolicy, BriefQualityWarning } from './intake/types.js';
import type { VerifyStageResult, VerifyStepStatus } from './run-tasks/verify-stage.js';
import { findModelProfile } from './routing/model-profiles.js';

export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type AgentType = 'standard' | 'complex';
export type AgentCapability = 'web_search' | 'web_fetch';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';

/**
 * Stages whose execution we record per-stage stats for.
 *
 * `terminal` is intentionally NOT here — it is a heartbeat-display-only state
 * (signaling "the lifecycle is done") and has no work to time, no model that
 * ran during it, no cost to attribute. `HeartbeatStage` (in `heartbeat.ts`)
 * includes `terminal`; `StageName` does not. If you add another display-only
 * stage in the future, exclude it from `StageName` for the same reason.
 */
export type StageName =
  | 'implementing' | 'verifying' | 'spec_review' | 'spec_rework'
  | 'quality_review' | 'quality_rework' | 'diff_review' | 'committing';

interface BaseStageStats {
  entered:       boolean;
  durationMs:    number | null;
  costUSD:       number | null;
  agentTier:     'standard' | 'complex' | null;
  modelFamily:   string | null;
  model:         string | null;
  // New in v3.9.0 — populated by the per-stage idle tracker; null when the
  // stage was never entered (so consumers can distinguish "not run" from
  // "ran with zero activity").
  maxIdleMs:     number | null;
  totalIdleMs:   number | null;
  activityEvents:number | null;
}

export type ReviewVerdict =
  | 'approved' | 'concerns' | 'changes_required' | 'annotated' | 'error' | 'skipped' | 'not_applicable';

export type VerifyOutcome   = 'passed' | 'failed' | 'skipped' | 'not_applicable';
export type VerifySkipReason = 'no_command' | 'dirty_worktree' | 'not_applicable' | 'other';

// One union member per stage so `Extract<RawStageStats, { stage: 'X' }>` resolves
// to a non-`never` variant for every stage in StageStatsMap below. (A union of
// literal stages on a single member would make Extract fail because the member's
// `stage` field doesn't extend any one literal.)
export type RawStageStats =
  | (BaseStageStats & { stage: 'implementing' })
  | (BaseStageStats & { stage: 'spec_rework' })
  | (BaseStageStats & { stage: 'quality_rework' })
  | (BaseStageStats & { stage: 'committing' })
  | (BaseStageStats & {
      stage:      'verifying';
      outcome:    VerifyOutcome   | null;
      skipReason: VerifySkipReason | null;
    })
  | (BaseStageStats & {
      stage:      'spec_review';
      verdict:    ReviewVerdict | null;
      roundsUsed: number        | null;
    })
  | (BaseStageStats & {
      stage:      'quality_review';
      verdict:    ReviewVerdict | null;
      roundsUsed: number        | null;
    })
  | (BaseStageStats & {
      stage:      'diff_review';
      verdict:    ReviewVerdict | null;
      roundsUsed: number        | null;
    });

export type StageStatsMap = {
  implementing:   Extract<RawStageStats, { stage: 'implementing' }>;
  verifying:      Extract<RawStageStats, { stage: 'verifying' }>;
  spec_review:    Extract<RawStageStats, { stage: 'spec_review' }>;
  spec_rework:    Extract<RawStageStats, { stage: 'spec_rework' }>;
  quality_review: Extract<RawStageStats, { stage: 'quality_review' }>;
  quality_rework: Extract<RawStageStats, { stage: 'quality_rework' }>;
  diff_review:    Extract<RawStageStats, { stage: 'diff_review' }>;
  committing:     Extract<RawStageStats, { stage: 'committing' }>;
};

export interface AgentConfig {
  type: 'openai-compatible' | 'claude' | 'claude-compatible' | 'codex'
  model: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  capabilities?: AgentCapability[]
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  inputTokenSoftLimit?: number
}

export interface FallbackOverride {
  role: 'implementer' | 'specReviewer' | 'qualityReviewer' | 'diffReviewer';
  loop: 'spec' | 'quality' | 'diff';
  attempt: number;
  assigned: AgentType;
  used: AgentType | 'none';
  reason: 'transport_failure' | 'not_configured';
  triggeringStatus?: RunStatus;
  bothUnavailable: boolean;
}

export interface FormatConstraints {
  inputFormat?: 'json' | 'yaml' | 'xml' | 'csv' | 'markdown';
  outputFormat?: 'json' | 'yaml' | 'xml' | 'csv' | 'markdown';
}

export interface TaskSpec {
  prompt: string
  agentType?: AgentType
  filePaths?: string[]
  done?: string
  contextBlockIds?: string[]
  tools?: ToolMode
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
  maxCostUSD?: number
  reviewPolicy?: 'full' | 'spec_only' | 'diff_only' | 'off' | 'quality_only'
  briefQualityPolicy?: BriefQualityPolicy
  parentModel?: string
  formatConstraints?: FormatConstraints
  skipCompletionHeuristic?: boolean
  expectedCoverage?: { minSections?: number; sectionPattern?: string; requiredMarkers?: string[] }
  requiredCapabilities?: AgentCapability[]
  testCommand?: string
  verifyCommand?: string[]
  autoCommit?: boolean
  planContext?: string
}

export interface CodexProviderConfig { type: 'codex'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeProviderConfig { type: 'claude'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeCompatibleProviderConfig { type: 'claude-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface OpenAICompatibleProviderConfig { type: 'openai-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; hostedTools?: 'web_search'[]; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export type ProviderConfig = CodexProviderConfig | ClaudeProviderConfig | ClaudeCompatibleProviderConfig | OpenAICompatibleProviderConfig

export interface MultiModelConfig {
  agents: { standard: AgentConfig; complex: AgentConfig }
  defaults: { timeoutMs: number; stallTimeoutMs: number; maxCostUSD: number; tools: ToolMode; sandboxPolicy: SandboxPolicy; largeResponseThresholdChars?: number; parentModel?: string }
  diagnostics?: { log: boolean; logDir?: string; verbose?: boolean }
  clarifications?: { maxRoundsPerDraft?: number }
  server: {
    bind: string
    port: number
    auth: { tokenFile: string }
    limits: { maxBodyBytes: number; batchTtlMs: number; idleProjectTimeoutMs: number; clarificationTimeoutMs: number; projectCap: number; maxBatchCacheSize: number; maxContextBlockBytes: number; maxContextBlocksPerProject: number; shutdownDrainMs: number }
    autoUpdateSkills: boolean
  }
}

export interface Commit {
  sha: string
  subject: string
  body: string
  filesChanged: string[]
  authoredAt: string
}

export interface RunResult {
  output: string
  status: RunStatus
  usage: TokenUsage
  turns: number
  filesRead: string[]
  filesWritten: string[]
  toolCalls: string[]
  outputIsDiagnostic: boolean
  escalationLog: AttemptRecord[]
  durationMs?: number
  directoriesListed?: string[]
  error?: string
  errorCode?: string
  retryable?: boolean
  briefQualityWarnings?: BriefQualityWarning[]
  terminationReason?: TerminationReason | 'round_cap' | 'cost_ceiling' | 'all_tiers_unavailable'
  reviewRounds?: { spec: number; quality: number; metadata: number; cap: number }
  concerns?: Array<{ source: 'spec_review' | 'quality_review' | 'diff_review' | 'verification' | 'diff_truncated'; severity: 'low' | 'medium' | 'high'; message: string }>
  structuredError?: { code: 'verify_command_error' | 'commit_metadata_invalid' | 'commit_metadata_repair_modified_files' | 'dirty_worktree' | 'diff_review_rejected' | 'runner_crash' | 'rate_limit_exceeded' | 'executor_error'; message: string; where?: string; step?: number; status?: VerifyStepStatus; attemptsUsed?: number; dirtyTreePreserved?: boolean }
  workerStatus?: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_aborted' | 'failed'
  specReviewStatus?: 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable'
  specReviewReason?: string
  filePathsSkipped?: boolean
  fileArtifactsMissing?: boolean
  commits?: Commit[]
  commitError?: string
  capExhausted?: 'turn' | 'cost' | 'wall_clock'
  /** True when the orchestrator's stall watchdog fired and force-aborted
   *  the in-flight provider.run mid-task. Distinct from cap exhaustion —
   *  signals "no progress" rather than "budget exhausted". */
  stallTriggered?: boolean
  /** Longest silent gap between LLM/tool/text activity events seen anywhere
   *  in the lifecycle (across all stages). Use to retro-tune stallTimeoutMs. */
  taskMaxIdleMs?: number | null
  lifecycleClarificationRequested?: boolean
  workerError?: Error
  /** Per-stage raw stats (Phase 0). Bucketing happens in the telemetry event-builder. */
  stageStats?: StageStatsMap
  // 3.3.0 (T3): always populated by reviewed-lifecycle's verify stage when an
  // artifact-producing task runs through that path. Optional in the type so that
  // non-artifact paths and direct provider calls compile without per-site defaults.
  // The spec says "always present" — that invariant holds at the lifecycle boundary;
  // here the type is permissive to keep migration mechanical.
  verification?: VerifyStageResult
  qualityReviewStatus?: 'approved' | 'changes_required' | 'annotated' | 'skipped' | 'error' | 'not_applicable'
  qualityReviewReason?: string
  structuredReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  agents?: {
    implementer: 'standard' | 'complex' | 'not_run'
    implementerHistory?: AgentType[]
    implementerToolMode?: 'none' | 'readonly' | 'no-shell' | 'full'
    implementerCapabilities?: ('web_search' | 'web_fetch')[]
    specReviewer: 'standard' | 'complex' | 'skipped' | 'not_applicable'
    specReviewerHistory?: (AgentType | 'skipped')[]
    qualityReviewer: 'standard' | 'complex' | 'skipped' | 'not_applicable'
    qualityReviewerHistory?: (AgentType | 'skipped')[]
    fallbackOverrides?: FallbackOverride[]
  }
  models?: { implementer: string; specReviewer: string | null; qualityReviewer: string | null }
  implementationReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  specReviewReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  qualityReviewReport?: import('./reporting/structured-report.js').ParsedStructuredReport
}

export interface Provider { name: string; config: ProviderConfig; run(prompt: string, options?: RunOptions): Promise<RunResult> }

export function computeCostUSD(inputTokens: number, outputTokens: number, config: ProviderConfig): number | null {
  const explicitRates = resolveRatePair(config.inputCostPerMTok, config.outputCostPerMTok);
  if (explicitRates !== null) return (inputTokens * explicitRates.input + outputTokens * explicitRates.output) / 1_000_000;
  const profile = findModelProfile(config.model);
  const profileRates = resolveRatePair(profile.inputCostPerMTok, profile.outputCostPerMTok);
  if (profileRates === null) return null;
  return (inputTokens * profileRates.input + outputTokens * profileRates.output) / 1_000_000;
}

export function computeSavedCostUSD(actualCostUSD: number | null, inputTokens: number, outputTokens: number, parentModel: string | undefined): number | null {
  if (actualCostUSD === null || parentModel === undefined) return null;
  const profile = findModelProfile(parentModel);
  const profileRates = resolveRatePair(profile.inputCostPerMTok, profile.outputCostPerMTok);
  if (profileRates === null) return null;
  return (inputTokens * profileRates.input + outputTokens * profileRates.output) / 1_000_000 - actualCostUSD;
}

function resolveRatePair(inputCostPerMTok: number | undefined, outputCostPerMTok: number | undefined): { input: number; output: number } | null {
  if (inputCostPerMTok !== undefined && outputCostPerMTok !== undefined && Number.isFinite(inputCostPerMTok) && Number.isFinite(outputCostPerMTok) && inputCostPerMTok >= 0 && outputCostPerMTok >= 0) return { input: inputCostPerMTok, output: outputCostPerMTok };
  return null;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T, abort?: AbortController, externalSignal?: AbortSignal): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let externalAbortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    const fire = (): void => {
      abort?.abort();
      resolve(onTimeout());
    };
    timeoutId = setTimeout(fire, timeoutMs);
    if (externalSignal) {
      if (externalSignal.aborted) {
        fire();
      } else {
        externalAbortHandler = fire;
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (externalAbortHandler && externalSignal) externalSignal.removeEventListener('abort', externalAbortHandler);
  });
}
