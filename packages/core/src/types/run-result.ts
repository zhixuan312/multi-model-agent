// RunResult — the per-run shape every worker returns. Matches spec
// architecture.md `types/run-result.ts` slot.
import type {
  AttemptRecord,
  CostBreakdown,
  RunOptions,
  RunStatus,
  TerminationReason,
  TokenUsage,
} from '../providers/runner-types.js';
import type { VerifyStageResult, VerifyStepStatus } from '../lifecycle/handlers/verify-stage.js';
import type { AgentType } from './task-spec.js';
import type { ProviderConfig, FallbackOverride } from './config.js';
import type { StageStatsMap } from './stage-stats.js';

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
  structuredError?: { code: 'validator_verify_command_failed' | 'validator_commit_metadata_invalid' | 'validator_commit_metadata_repair_modified_files' | 'validator_dirty_worktree' | 'review_diff_rejected' | 'runner_crash' | 'provider_rate_limited' | 'provider_api_error' | 'provider_transport_failure' | 'provider_timeout' | 'provider_api_aborted' | 'validator_silent_incomplete' | 'config_main_agent_pricing_unresolvable'; message: string; where?: string; step?: number; status?: VerifyStepStatus; attemptsUsed?: number; dirtyTreePreserved?: boolean }
  workerStatus?: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'review_loop_capped' | 'failed'
  specReviewStatus?: 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable'
  specReviewReason?: string
  filePathsSkipped?: boolean
  fileArtifactsMissing?: boolean
  commits?: Commit[]
  commitError?: string
  incompleteReason?: 'turn_cap' | 'cost_cap' | 'timeout' | 'missing_sections'
  /** True when the orchestrator's stall watchdog fired and force-aborted
   *  the in-flight provider.run mid-task. Distinct from cap exhaustion —
   *  signals "no progress" rather than "budget exhausted". */
  stallTriggered?: boolean
  /** Number of times the stall watchdog fired across this task's lifecycle.
   *  Multiple stalls in a single task are possible when the watchdog resets
   *  across stage transitions. */
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
  /** Per-stage raw stats. Bucketing happens in the telemetry event-builder. */
  stageStats?: StageStatsMap
  // Always populated by the verify stage when an artifact-producing task
  // runs through the lifecycle. Optional in the type so non-artifact paths
  // and direct provider calls compile without per-site defaults. The spec
  // says "always present" — that invariant holds at the lifecycle boundary;
  // here the type stays permissive to keep migration mechanical.
  verification?: VerifyStageResult
  qualityReviewStatus?: 'approved' | 'changes_required' | 'annotated' | 'skipped' | 'error' | 'not_applicable'
  qualityReviewReason?: string
  diffReviewStatus?: 'approved' | 'changes_required' | 'skipped' | 'error' | 'not_applicable'
  annotatedFindings?: import('../review/review-types.js').AnnotatedFinding[]
  /** Reviewer findings extracted via typed structured output (OpenAI Agent.outputType).
   *  null on non-review-mode runs and on Claude/Codex runners (which still use the
   *  JSON-block extraction path). When non-null, downstream consumers MUST prefer it
   *  over parseReviewerFindings(...). */
  parsedFindings: import('../review/review-types.js').AnnotatedFinding[] | null
  structuredReport?: import('../reporting/structured-report.js').ParsedStructuredReport
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
  implementationReport?: import('../reporting/structured-report.js').ParsedStructuredReport
  specReviewReport?: import('../reporting/structured-report.js').ParsedStructuredReport
  qualityReviewReport?: import('../reporting/structured-report.js').ParsedStructuredReport
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
