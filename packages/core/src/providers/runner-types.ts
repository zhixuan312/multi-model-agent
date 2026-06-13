import type {
  AgentType,
  Effort,
  FormatConstraints,
  SandboxPolicy,
  TaskSpec,
  ToolMode,
} from '../types.js';
import type { EnvelopeBus } from '../events/envelope-bus.js';
export type { TokenUsage } from '../types/run-result.js';

export type RunStatus =
  | 'ok'
  | 'incomplete'
  | 'timeout'
  | 'error'
  | 'brief_too_vague'
  | 'unavailable';

/** Canonical 4-field token-count shape. reasoningTokens are summed into
 *  outputTokens by each runner before emitting. totalTokens, cachedTokens,
 *  and per-provider breakdowns are computed on demand — they are not stored.
 *
 *  **Disjoint-partition contract.** The four fields are mutually exclusive
 *  buckets — every token counted in exactly one field. Specifically:
 *    - `inputTokens` is the NON-CACHED prompt-token count for this turn
 *      (Anthropic's definition: tokens after the last cache breakpoint).
 *    - `cachedReadTokens` is the count of prompt tokens read from cache.
 *    - `cachedNonReadTokens` is the count of prompt tokens written to cache
 *      (cache-creation; billed at 1.25× input for Anthropic 5-min TTL,
 *      2.0× for 1-hour TTL; OpenAI/codex does not emit this field).
 *    - `outputTokens` is the count of model-generated tokens (including
 *      reasoning tokens; the rate-card output rate covers both).
 *
 *  Provider adapters MUST normalize their wire shape to this contract.
 *  Anthropic's Messages API already partitions cleanly so pass-through is
 *  correct. OpenAI / codex CLI emits GROSS `input_tokens` that INCLUDES
 *  `cached_input_tokens` as a subset; adapters MUST subtract cached from
 *  gross before populating `inputTokens` here. See
 *  `providers/codex-cli-session.ts:absorbUsage` for the normalization. */
export interface TerminationReason {
  /** Why the task stopped. 'finished' means the worker returned normally — check
   *  workerSelfAssessment for the worker's own view of completion. */
  cause: 'finished' | 'incomplete' | 'timeout' | 'time_ceiling' | 'degenerate_exhausted' | 'brief_too_vague' | 'error'
  turnsUsed: number
  hasFileArtifacts: boolean
  usedShell: boolean
  workerSelfAssessment: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_capped' | null
  wasPromoted: boolean
  /** Wall-clock ms elapsed when the termination condition tripped.
   *  Populated for time_ceiling aborts; omitted for other causes. */
  wallClockMs?: number
}

export interface AttemptRecord {
  provider: string
  status: RunStatus
  turns: number
  inputTokens: number
  outputTokens: number
  costUSD: number | null
  /** Character count of the canonical orchestrator-side initial brief. */
  initialPromptLengthChars: number
  /** sha256 hex of the canonical orchestrator-side initial brief. */
  initialPromptHash: string
  /** Why this attempt was abandoned, if it was. Empty if status === 'ok'. */
  reason?: string
}

export interface RunOptions {
  tools?: ToolMode
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
  expectedCoverage?: TaskSpec['expectedCoverage']
  skipCompletionHeuristic?: boolean
  /** Optional callback invoked by runners and the escalation orchestrator to
   *  stream in-flight internal progress events. */
  onProgress?: (event: InternalRunnerEvent) => void
  /** Called exactly once per attempt when the runner has assembled the
   *  canonical orchestrator-side initial brief. */
  onInitialRequest?: (meta: { lengthChars: number; sha256: string }) => void
  mainModel?: string
  formatConstraints?: FormatConstraints
  /** External abort signal — when fired, the runner force-salvages and
   *  returns a `timeout` result via the same path as the per-call timeout.
   *  Used by the orchestrator's stall watchdog. */
  abortSignal?: AbortSignal
  /** Run mode: 'standard' for normal execution, 'review' for typed
   *  structured output review via Agent.outputType. Default 'standard'. */
  runMode?: 'standard' | 'review'
  /** Appended to Agent.instructions (or the equivalent system-level prompt
   *  in each runner) after the standard prevention-layer system prompt.
   *  Used by the reviewer path so the stable review rubric sits in the
   *  system layer (cacheable) while the variable evidence stays in the
   *  user message. */
  instructionsSuffix?: string
  /** Hints for prompt-cache behaviour. Runners interpret these as
   *  provider-specific cache markers (e.g. Claude ephemeral cache_control). */
  cacheHints?: { cacheableSystemPrompt?: boolean }
  /** Bus for emitting per-turn / per-runner-call observability events. When
   *  present, the runner + adapter emit provider-specific events (e.g.
   *  `claude_turn_started`, `claude_turn_completed`) that the server's
   *  EnvelopeBus consume. */
  bus?: EnvelopeBus
  taskId?: string
  taskIndex?: number
  tier?: string
  stageLabel?: string
}

/** Internal progress events emitted by runners and the escalation orchestrator. */
export type InternalRunnerEvent =
  | {
      kind: 'worker_start'
      model: string
      providerType: 'claude' | 'codex'
      tier: AgentType
    }
  | { kind: 'turn_start'; turn: number; provider: string; model: string }
  | { kind: 'tool_call'; turn: number; toolSummary: string }
  | { kind: 'text_emission'; turn: number; chars: number; preview: string }
  | {
      kind: 'turn_complete'
      turn: number
      cumulativeInputTokens: number
      cumulativeOutputTokens: number
      cumulativeCachedReadTokens?: number
      cumulativeCachedNonReadTokens?: number
      cumulativeReasoningTokens?: number
    }
  | {
      kind: 'injection'
      injectionType:
        | 'reground'
        | 'supervise_empty'
        | 'supervise_thinking'
        | 'supervise_fragment'
        | 'supervise_insufficient_coverage'
      turn: number
      contentLengthChars: number
    }
  | {
      kind: 'escalation_start'
      previousProvider: string
      previousReason: string
      nextProvider: string
    }
  | { kind: 'retry'; attempt: number; previousStatus: RunStatus; delayMs: number }
  | { kind: 'done'; status: RunStatus }

/** Single progress event shape emitted by ActivityTracker during task execution. */
export type ProgressEvent = {
  kind: 'heartbeat'
  elapsed: string
  provider: string
  idleSinceLlmMs: number
  idleSinceToolMs: number
  idleSinceTextMs: number
  stage: 'implementing' | 'review' | 'rework' | 'annotating' | 'committing' | 'terminal'
  stageIndex: number
  stageCount: number
  reviewRound?: number
  attemptCap?: number
  progress: {
    filesWritten: number
  }
  costUSD: number | null
  costDeltaVsMainUSD: number | null
  final: boolean
  headline: string
  /** Per-stage idle time (ms since last LLM/tool/text event in the current stage). */
  stageIdleMs: number
  /** Lightweight state snapshot for use by recordHeartbeat. */
  snapshot: import('../bounded-execution/activity-tracker-types.js').HeadlineSnapshot
}
