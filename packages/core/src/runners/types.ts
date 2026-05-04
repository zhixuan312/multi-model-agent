import type { ContextBlockStore } from '../context/context-block-store.js';
import type {
  AgentType,
  Effort,
  FormatConstraints,
  SandboxPolicy,
  TaskSpec,
  ToolMode,
} from '../types.js';
import type { ResearchToolDefinition } from '../research/types.js';

export type RunStatus =
  | 'ok'
  | 'incomplete'
  | 'timeout'
  | 'api_aborted'
  | 'api_error'
  | 'provider_transport_failure'
  | 'error'
  | 'brief_too_vague'
  | 'cost_exceeded'
  | 'unavailable';

/** Canonical 4-field token-count shape. reasoningTokens are summed into
 *  outputTokens by each runner before emitting. totalTokens, cachedTokens,
 *  and per-provider breakdowns are computed on demand — they are not stored. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  cachedNonReadTokens: number
}

/** Cost fields formerly co-located in TokenUsage (3.12). These are NOT token
 *  counts; they live on RunResult alongside usage. */
export interface CostBreakdown {
  costUSD: number | null
  /** Actual cost minus estimated parent cost. Negative = worker cheaper (savings). */
  costDeltaVsParentUSD: number | null
}

export interface TerminationReason {
  /** Why the task stopped. 'finished' means the worker returned normally — check
   *  workerSelfAssessment for the worker's own view of completion. */
  cause: 'finished' | 'incomplete' | 'timeout' | 'cost_exceeded' | 'time_ceiling' | 'degenerate_exhausted'
       | 'api_error' | 'provider_transport_failure' | 'api_aborted' | 'brief_too_vague' | 'error'
  turnsUsed: number
  hasFileArtifacts: boolean
  usedShell: boolean
  workerSelfAssessment: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_capped' | null
  wasPromoted: boolean
  /** Wall-clock ms elapsed when the termination condition tripped.
   *  Populated for time_ceiling aborts; omitted for other causes. */
  wallClockMs?: number
}

/**
 * Single provider-attempt record inside an escalation chain. The orchestrator
 * (`delegateWithEscalation`) pushes one entry per `provider.run(...)` call.
 */
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
  parentModel?: string
  maxCostUSD?: number
  formatConstraints?: FormatConstraints
  /** External abort signal — when fired, the runner force-salvages and
   *  returns a `timeout` result via the same path as the per-call timeout.
   *  Used by the orchestrator's stall watchdog. */
  abortSignal?: AbortSignal
  /** Run mode: 'standard' for normal execution, 'review' for typed
   *  structured output review via Agent.outputType. Default 'standard'. */
  runMode?: 'standard' | 'review'
  /** Optional task-specific tool injection. When present, runners merge
   *  these tools into the worker's tool surface ON TOP OF whatever
   *  `tools: ToolMode` would normally produce. Runners MUST treat
   *  undefined as a no-op. */
  customToolset?: ResearchToolDefinition[]
  /** Appended to Agent.instructions (or the equivalent system-level prompt
   *  in each runner) after the standard prevention-layer system prompt.
   *  Used by the reviewer path so the stable review rubric sits in the
   *  system layer (cacheable) while the variable evidence stays in the
   *  user message. */
  instructionsSuffix?: string
  /** Hints for prompt-cache behaviour. Runners interpret these as
   *  provider-specific cache markers (e.g. Claude ephemeral cache_control). */
  cacheHints?: { cacheableSystemPrompt?: boolean }
}

/** Runtime dependencies for `runTasks`. */
export interface RunTasksRuntime {
  contextBlockStore?: ContextBlockStore
}

/** Internal progress events emitted by runners and the escalation orchestrator. */
export type InternalRunnerEvent =
  | {
      kind: 'worker_start'
      model: string
      providerType: 'claude' | 'openai-compatible' | 'codex'
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

/** Single progress event shape emitted by HeartbeatTimer during task execution. */
export type ProgressEvent = {
  kind: 'heartbeat'
  elapsed: string
  provider: string
  idleSinceLlmMs: number
  idleSinceToolMs: number
  idleSinceTextMs: number
  stage: 'implementing' | 'spec_review' | 'spec_rework' | 'quality_review' | 'quality_rework' | 'verifying' | 'diff_review' | 'committing' | 'terminal'
  stageIndex: number
  stageCount: number
  reviewRound?: number
  attemptCap?: number
  progress: {
    filesRead: number
    filesWritten: number
    toolCalls: number
  }
  costUSD: number | null
  costDeltaVsParentUSD: number | null
  final: boolean
  headline: string
  /** Per-stage idle time (ms since last LLM/tool/text event in the current stage). */
  stageIdleMs: number
  /** Lightweight state snapshot for use by recordHeartbeat to update BatchRegistry. */
  snapshot: import('../batch-registry.js').HeadlineSnapshot
}
