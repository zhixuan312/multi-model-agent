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
export type { TokenUsage } from '../providers/runner-types.js';
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
  /**
   * Existing per-task cost surface — `{ costUSD, costDeltaVsMainUSD }`.
   * Kept for back-compat. New readers should prefer `actualCostUSD`
   * which is populated by composeResponse from `sumStageCosts` and
   * matches the batch roll-up's per-task contribution.
   */
  cost?: CostBreakdown
  /**
   * A11.2 (4.2.3+): canonical per-task total cost on the public envelope,
   * computed as the sum of `stageStats[*].costUSD` across entered stages
   * (same logic as the batch-level `costSummary.totalActualCostUSD`).
   * Equal to `cost.costUSD` for runs where stage-level pricing is
   * registered; null when no stage carried a finite cost (e.g. mock
   * provider runs). Populated by composeResponse — workers and runners
   * may leave this undefined.
   */
  actualCostUSD?: number | null
  // ── Pipeline-redesign envelope fields (4.3.0+, spec §3.5) ────────────
  /** Stage 4 structured annotation: completionPercent, perStep, verify, concerns. */
  completionAnnotation?: {
    completionPercent: number;
    perStep: Array<{ step: string; status: 'done' | 'partial' | 'missing'; note: string | null }>;
    verify: {
      ran: boolean;
      passed: boolean | null;
      exitCode: number | null;
      command: string[];
      tailOutput: string | null;
    };
    concerns: string[];
  };
  /** Stage 4 deterministic commit-gate %: min(backstop, annotatorPercent). */
  commitGatePercent?: number
  /** Spec lint-reviewer raw report. */
  specReviewerNotes?: string
  /** Quality lint-reviewer raw report. */
  qualityReviewerNotes?: string
  /** Combined review verdict from both reviewers. */
  reviewVerdict?: 'approved' | 'changes_required'
  /** Merged deviations from both reviewers. */
  reviewFindings?: Array<{ source: 'spec' | 'quality'; text: string }>
  /** Rework worker free-text summary (set when rework stage fired). */
  reworkOutput?: string
  /** True if rework stage applied edits; false if reviewers approved so it skipped; undefined if stage didn't fire. */
  reworkApplied?: boolean
  /** Stage 4 deterministic verify-command result (run inside annotate handler). */
  verifyResult?: {
    ran: boolean;
    passed: boolean | null;
    exitCode: number | null;
    command: string[];
    tailOutput: string | null;
  }
  turns: number
  filesRead: string[]
  filesWritten: string[]
  /** A4b §2a (4.2.2+): worker write attempts that failed the path-validity
   *  filter — shell heredoc commands, absolute paths, paths containing
   *  shell metacharacters. NOT real, verifiable disk artifacts. The
   *  lifecycle layer drains this into LifecycleContext.diagnostics for the
   *  `writes_unverifiable` daemon-log message; not surfaced on the public
   *  HTTP envelope. Optional so legacy consumers / mocks compile without
   *  setting the field. */
  filesWrittenRejected?: string[]
  /** A4b §2b (4.2.2+): post-§2a paths that didn't pass `stat()` against
   *  taskSpec.cwd at terminal time — the worker reported a path but no
   *  artifact actually landed there. Surfaced on the public envelope so
   *  callers can see "you said you wrote X but I can't find it." */
  filesWrittenMissing?: string[]
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
  concerns?: Array<{ source: 'review' | 'spec_review' | 'quality_review' | 'diff_review' | 'verification' | 'diff_truncated'; severity: 'critical' | 'low' | 'medium' | 'high'; message: string }>
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
  /** Per-criterion narratives from parallel-criteria fan-out. Read-only
   *  routes populate this; artifact-producing routes leave it undefined.
   *  The merge annotator reads this to produce the unified
   *  annotatedFindings array. */
  workerOutputs?: Array<{ criterionId: string; criterionTitle: string; narrative: string }>
  /** IDs of criteria whose sub-workers succeeded. Read-only routes only. */
  partialCriteriaCovered?: string[]
  /** Failed criteria with reason. Read-only routes only. */
  partialCriteriaFailed?: Array<{ id: string; title: string; reason: 'timeout' | 'transport' | 'parse' | 'other'; lastError: string }>
}

export interface ReviewPromptParts {
  systemPrefix: string;
  userBody: string;
}

export interface CacheHints {
  cacheableSystemPrompt?: boolean;
}

export type ReviewRunOptions = RunOptions & { cacheHints?: CacheHints };

// v4.4 — Session-based provider boundary. `openSession` is the single
// entry point; every call lasts one Session, which represents a thread
// the underlying SDK can resume across turns.
export interface Provider {
  name: string;
  config: ProviderConfig;
  openSession(opts: SessionOpts): Session;
}

/** Stage-tagging payload for a single session.send() call. */
export interface TurnOpts {
  /** e.g. 'implementing', 'review', 'rework', 'annotating', 'committing'. */
  stageLabel: string;
}

export interface SessionOpts {
  cwd: string;
  allowedHosts?: ReadonlySet<string>;
  /** Hard wall-clock deadline (epoch ms). External guard aborts at this time. */
  wallClockDeadline: number;
  /** Idle threshold (ms): no SDK event for this long → abort. */
  idleStallTimeoutMs: number;
  /** Advisory only. Authoritative enforcement = mma-side CostMeter (task-wide). */
  maxCostUSD?: number;
  /** Wired through to the SDK's own cancellation parameter. */
  abortSignal: AbortSignal;
  /** Telemetry sink. Optional. Untyped to avoid a circular import with
   *  channels/event-bus; concrete shape verified at the bind site. */
  bus?: unknown;
  /** Initial stage label so telemetry has one before the first TurnOpts lands. */
  initialStageLabel?: string;
}

export interface TurnResult {
  output: string;
  usage: TokenUsage;
  filesRead: string[];
  filesWritten: string[];
  toolCallsByName: Record<string, number>;
  turns: number;
  durationMs: number;
  /** USD cost when known (>= 0). `null` means cost couldn't be determined
   *  (e.g. mock providers, missing rate-card entry). Distinct from `0`,
   *  which means a real zero charge — important for downstream telemetry
   *  that treats null as "no data". */
  costUSD: number | null;
  terminationReason: 'ok' | 'cost_exceeded' | 'time_exceeded' | 'cap_exhausted' | 'stalled' | 'aborted' | 'error';
  errorCode?: string;
  errorMessage?: string;
  /** Worker's self-assessment as written into its structured report.
   *  Optional — populated by adapters that parse the SDK output (or by
   *  test mocks). assembleRunResult prefers this over its termination-
   *  reason-derived default so the "incomplete + worker self-assessed
   *  done" promotion path can fire. */
  workerSelfAssessment?: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_capped';
  /** True when the assistantText is a diagnostic shell (e.g.
   *  "Sub-agent error: …" or scratchpad-only fallback) rather than real
   *  worker content. Lets delegateWithEscalation's selection prefer any
   *  real-content attempt over a longer diagnostic-only attempt. */
  outputIsDiagnostic?: boolean;
}

export interface Session {
  send(instruction: string, opts?: TurnOpts): Promise<TurnResult>;
  close(): Promise<void>;
}
