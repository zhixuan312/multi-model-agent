import type {
  AttemptRecord,
  CostBreakdown,
  RunOptions,
  RunStatus,
  TerminationReason,
  TokenUsage,
} from './providers/runner-types.js';
import type { BriefQualityPolicy } from './intake/types.js';
import type { VerifyStageResult, VerifyStepStatus } from './lifecycle/handlers/verify-stage.js';
import type { ResearchToolDefinition } from './research/types.js';
export type ToolMode = 'none' | 'readonly' | 'no-shell' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type AgentType = 'standard' | 'complex';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_capped' | 'failed';
export type { ErrorCode } from './error-codes.js';

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
  // Per-stage telemetry metrics — populated at stage completion.
  inputTokens:         number | null;
  outputTokens:        number | null;
  cachedReadTokens:    number | null;
  cachedNonReadTokens: number | null;
  turnCount:           number | null;
  toolCallCount:      number | null;
  filesReadCount:     number | null;
  filesWrittenCount:  number | null;
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
  reason: 'transport_failure' | 'not_configured' | 'reviewer_separation_unsatisfiable';
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
  reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none'
  briefQualityPolicy?: BriefQualityPolicy
  mainModel?: string
  formatConstraints?: FormatConstraints
  skipCompletionHeuristic?: boolean
  expectedCoverage?: { minSections?: number; sectionPattern?: string; requiredMarkers?: string[] }
  testCommand?: string
  verifyCommand?: string[]
  autoCommit?: boolean
  planContext?: string
  /**
   * Optional task-specific tool injection. When present, runner adapters
   * merge these tools into the worker's tool surface ON TOP of whatever
   * `tools: ToolMode` would normally produce. Used by `/explore` for the
   * external researcher (taskIndex=1) only; all other executors leave this
   * undefined. Runners MUST treat `undefined` as a no-op.
   */
  customToolset?: ResearchToolDefinition[]
}

export interface CodexProviderConfig { type: 'codex'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeProviderConfig { type: 'claude'; model: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface ClaudeCompatibleProviderConfig { type: 'claude-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export interface OpenAICompatibleProviderConfig { type: 'openai-compatible'; model: string; baseUrl: string; apiKey?: string; apiKeyEnv?: string; effort?: Effort; timeoutMs?: number; sandboxPolicy?: SandboxPolicy; costTier?: CostTier; inputCostPerMTok?: number; outputCostPerMTok?: number; inputTokenSoftLimit?: number }
export type ProviderConfig = CodexProviderConfig | ClaudeProviderConfig | ClaudeCompatibleProviderConfig | OpenAICompatibleProviderConfig

export interface MultiModelConfig {
  agents: { standard: AgentConfig; complex: AgentConfig }
  defaults: { timeoutMs: number; stallTimeoutMs: number; maxCostUSD: number; tools: ToolMode; sandboxPolicy: SandboxPolicy; largeResponseThresholdChars?: number; mainModel?: string }
  diagnostics?: { log: boolean; logDir?: string; verbose?: boolean }
  server: {
    bind: string
    port: number
    auth: { tokenFile: string }
    limits: { maxBodyBytes: number; batchTtlMs: number; idleProjectTimeoutMs: number; projectCap: number; maxBatchCacheSize: number; maxContextBlockBytes: number; maxContextBlocksPerProject: number; shutdownDrainMs: number }
    autoUpdateSkills: boolean
  }
  research: ResearchConfig
}

export interface ResearchConfig {
  brave: {
    apiKeys: string[]
    timeoutMs: number
    maxResultsPerQuery: number
    perCallBackoffMs: number
  }
  fetch: {
    maxRedirects: number
    connectTimeoutMs: number
    totalDeadlineMs: number
    maxBodyBytes: number
    allowPrivateNetwork: boolean
  }
  builtinAdapters: {
    arxiv: boolean
    semanticScholar: boolean
    githubSearch: boolean
    genericRss: boolean
  }
  userSources: string[]
  fetchAllowlistExtra: string[]
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
  cost?: CostBreakdown
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
  terminationReason?: TerminationReason | 'round_cap' | 'cost_ceiling' | 'time_ceiling' | 'all_tiers_unavailable'
  reviewRounds?: { spec: number; quality: number; metadata: number; cap: number }
  concerns?: Array<{ source: 'spec_review' | 'quality_review' | 'diff_review' | 'verification' | 'diff_truncated'; severity: 'critical' | 'low' | 'medium' | 'high'; message: string }>
  structuredError?: { code: 'validator_verify_command_failed' | 'commit_metadata_invalid' | 'commit_metadata_repair_modified_files' | 'validator_dirty_worktree' | 'diff_review_rejected' | 'runner_crash' | 'rate_limit_exceeded' | 'executor_error' | 'api_error' | 'provider_transport_failure' | 'timeout' | 'api_aborted' | 'incomplete_no_summary' | 'reviewer_separation_unsatisfiable'; message: string; where?: string; step?: number; status?: VerifyStepStatus; attemptsUsed?: number; dirtyTreePreserved?: boolean }
  workerStatus?: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_capped' | 'failed'
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
  /** Number of times the stall watchdog fired across this task's lifecycle.
   *  V3 replacement for the V2 boolean — multiple stalls in a single task
   *  are possible when the watchdog resets across stage transitions. */
  stallCount?: number
  /** Per-stage token allocation (optional — populated when runner tracks per-stage).
   *  Keyed by stage name; stages that didn't run have no entry. */
  perStageTokens?: Partial<Record<string, { input: number; output: number; cached: number; reasoning: number }>>
  /** Per-stage turn count (optional — populated when orchestration tags turns). */
  turnsByStage?: Partial<Record<string, number>>
  /** Per-stage sandbox violation count. */
  sandboxViolationCount?: number
  /** Longest silent gap between LLM/tool/text activity events seen anywhere
   *  in the lifecycle (across all stages). Use to retro-tune stallTimeoutMs. */
  taskMaxIdleMs?: number | null
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
  diffReviewStatus?: 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable'
  annotatedFindings?: import('./review/findings-schema.js').AnnotatedFinding[]
  /** Reviewer findings extracted via typed structured output (OpenAI Agent.outputType).
   *  null on non-review-mode runs and on Claude/Codex runners (which still use the
   *  JSON-block extraction path). When non-null, downstream consumers MUST prefer it
   *  over parseReviewerFindings(...). See Edit G2/G3. */
  parsedFindings: import('./review/findings-schema.js').AnnotatedFinding[] | null
  structuredReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  agents?: {
    implementer: 'standard' | 'complex' | 'not_run'
    implementerHistory?: AgentType[]
    implementerToolMode?: 'none' | 'readonly' | 'no-shell' | 'full'
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

export interface ReviewPromptParts {
  systemPrefix: string;
  userBody: string;
}

export interface CacheHints {
  cacheableSystemPrompt?: boolean;
}

export type ReviewRunOptions = RunOptions & { cacheHints?: CacheHints };

export interface Provider { name: string; config: ProviderConfig; run(prompt: string, options?: RunOptions): Promise<RunResult>; runReview?(parts: ReviewPromptParts, options?: ReviewRunOptions): Promise<RunResult> }

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
