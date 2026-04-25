import type { ContextBlockStore } from '../context/context-block-store.js';
import type {
  Effort,
  FormatConstraints,
  SandboxPolicy,
  TaskSpec,
  ToolMode,
} from '../types.js';

export type RunStatus =
  | 'ok'
  | 'incomplete'
  | 'timeout'
  | 'api_aborted'
  | 'api_error'
  | 'network_error'
  | 'error'
  | 'brief_too_vague'
  | 'cost_exceeded'
  | 'unavailable';

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUSD: number | null
  /** Estimated cost savings versus the declared parent model, if known. */
  savedCostUSD?: number | null
}

export interface TerminationReason {
  /** Why the task stopped. 'finished' means the worker returned normally — check
   *  workerSelfAssessment for the worker's own view of completion. */
  cause: 'finished' | 'incomplete' | 'timeout' | 'cost_exceeded' | 'degenerate_exhausted'
       | 'api_error' | 'network_error' | 'api_aborted' | 'brief_too_vague' | 'error'
  turnsUsed: number
  hasFileArtifacts: boolean
  usedShell: boolean
  workerSelfAssessment: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_aborted' | null
  wasPromoted: boolean
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
}

/** Runtime dependencies for `runTasks`. */
export interface RunTasksRuntime {
  contextBlockStore?: ContextBlockStore
}

/** Internal progress events emitted by runners and the escalation orchestrator. */
export type InternalRunnerEvent =
  | { kind: 'turn_start'; turn: number; provider: string }
  | { kind: 'tool_call'; turn: number; toolSummary: string }
  | { kind: 'text_emission'; turn: number; chars: number; preview: string }
  | {
      kind: 'turn_complete'
      turn: number
      cumulativeInputTokens: number
      cumulativeOutputTokens: number
    }
  | {
      kind: 'injection'
      injectionType:
        | 'reground'
        | 'supervise_empty'
        | 'supervise_thinking'
        | 'supervise_fragment'
        | 'supervise_insufficient_coverage'
        | 'watchdog_warning'
        | 'watchdog_force_salvage'
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
  stage: 'implementing' | 'spec_review' | 'spec_rework' | 'quality_review' | 'quality_rework'
  stageIndex: number
  stageCount: number
  reviewRound?: number
  maxReviewRounds?: number
  progress: {
    filesRead: number
    filesWritten: number
    toolCalls: number
  }
  costUSD: number | null
  savedCostUSD: number | null
  final: boolean
  headline: string
}
