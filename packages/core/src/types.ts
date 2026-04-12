import type { ContextBlockStore } from './context/context-block-store.js';
import { findModelProfile } from './routing/model-profiles.js';

// === Tool Mode & Sandbox ===

export type ToolMode = 'none' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';

// === 1.0.0 Agent Model ===

export type AgentType = 'standard' | 'complex';
export type AgentCapability = 'web_search' | 'web_fetch';

export interface AgentConfig {
  type: 'openai-compatible' | 'claude' | 'codex'
  model: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  capabilities?: AgentCapability[]
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  inputTokenSoftLimit?: number
}

export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type RunStatus =
  | 'ok'
  | 'incomplete'
  | 'max_turns'
  | 'timeout'
  | 'api_aborted'
  | 'api_error'
  | 'network_error'
  | 'error'
  | 'brief_too_vague'
  | 'cost_exceeded';

// === Task ===

export interface FormatConstraints {
  inputFormat?: 'json' | 'yaml' | 'xml' | 'csv' | 'markdown';
  outputFormat?: 'json' | 'yaml' | 'xml' | 'csv' | 'markdown';
}

export interface TaskSpec {
  prompt: string
  /** @deprecated Use agentType instead. provider is ignored by run-tasks. */
  provider?: string
  /** @deprecated Use agentType instead. tier is ignored by run-tasks. */
  tier?: string
  agentType?: AgentType
  requiredCapabilities?: AgentCapability[]
  tools?: ToolMode
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
  /** Optional context block ids to expand into the prompt before dispatch.
   *  Each id is resolved against `RunTasksRuntime.contextBlockStore` in
   *  order and its content is prepended to `prompt` separated by
   *  '\n\n---\n\n'. The field is stripped from the task that reaches the
   *  provider so runners never see it. See `expandContextBlocks`. */
  contextBlockIds?: string[]
  /** Optional caller-declared output expectations. When supplied, the
   *  supervision layer can validate the output for enumerable deliverables
   *  after syntactic completion checks pass. */
  expectedCoverage?: {
    /** Minimum section count. A section is a line matching `sectionPattern`. */
    minSections?: number
    /** Regex for section headings. Applied with the multiline flag. */
    sectionPattern?: string
    /** Substrings that must all appear somewhere in the output. */
    requiredMarkers?: string[]
  }
  /** Opt-out: when true, the runner skips the `no_terminator` and `fragment`
   *  short-output heuristics for this task. Use for tight-format outputs
   *  (single-line verdicts, CSV rows, opaque identifiers) that don't follow
   *  prose conventions. The `empty` and `thinking_only` degeneracy checks
   *  still fire independently. If `expectedCoverage` is also declared and
   *  passes, coverage is authoritative — you don't need this flag. */
  skipCompletionHeuristic?: boolean
  /** Opt-in progress capture for post-hoc execution observability. */
  includeProgressTrace?: boolean
  /** Optional hint about the parent session's model for saved-cost estimates. */
  parentModel?: string
  /** Brief quality policy for readiness evaluation. */
  briefQualityPolicy?: BriefQualityPolicy
  /** Optional budget for normalization. */
  maxCostUSD?: number
  /** Review policy for the execution loop. */
  reviewPolicy?: 'full' | 'spec_only' | 'off'
  /** Maximum number of spec review rework rounds. Defaults to 2. */
  maxReviewRounds?: number
  /** Optional format constraints for input/output. */
  formatConstraints?: FormatConstraints
}

// === Provider Config (discriminated union) ===

export interface CodexProviderConfig {
  type: 'codex'
  model: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
  /** Optional pricing in USD per million input tokens. Used to compute RunResult.usage.costUSD. */
  inputCostPerMTok?: number
  /** Optional pricing in USD per million output tokens. Used to compute RunResult.usage.costUSD. */
  outputCostPerMTok?: number
  /** Optional override for the per-provider input token soft limit
   *  used by the watchdog. When unset, falls back to the model profile
   *  default, then to a hardcoded 100_000 fallback. See spec A.1.4. */
  inputTokenSoftLimit?: number
}

export interface ClaudeProviderConfig {
  type: 'claude'
  model: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
  /** Optional pricing override; if set, recomputes costUSD from token usage instead of trusting the SDK. */
  inputCostPerMTok?: number
  outputCostPerMTok?: number
  /** Optional override for the per-provider input token soft limit
   *  used by the watchdog. When unset, falls back to the model profile
   *  default, then to a hardcoded 100_000 fallback. See spec A.1.4. */
  inputTokenSoftLimit?: number
}

export interface OpenAICompatibleProviderConfig {
  type: 'openai-compatible'
  model: string
  /** Required — must be specified. No default. */
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
  /** Optional pricing in USD per million input tokens. Used to compute RunResult.usage.costUSD. */
  inputCostPerMTok?: number
  /** Optional pricing in USD per million output tokens. Used to compute RunResult.usage.costUSD. */
  outputCostPerMTok?: number
  /** Optional override for the per-provider input token soft limit
   *  used by the watchdog. When unset, falls back to the model profile
   *  default, then to a hardcoded 100_000 fallback. See spec A.1.4. */
  inputTokenSoftLimit?: number
}

/** Discriminated union — each provider type has distinct required fields. */
export type ProviderConfig =
  | CodexProviderConfig
  | ClaudeProviderConfig
  | OpenAICompatibleProviderConfig

// === Config ===

export interface MultiModelConfig {
  providers: Record<string, ProviderConfig>
  agents?: {
    standard: AgentConfig
    complex: AgentConfig
  }
  defaults: {
    maxTurns: number
    timeoutMs: number
    tools: ToolMode
    /** Character threshold that triggers auto-switch from 'full' to
     *  'summary' response mode when the caller uses `responseMode: 'auto'`
     *  (the default). Optional — defaults to 65_536 when absent.
     *  Env var and buildMcpServer option can override at higher precedence. */
    largeResponseThresholdChars?: number
  }
}

// === Result ===

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUSD: number | null
  /** Estimated cost savings versus the declared parent model, if known. */
  savedCostUSD?: number | null
}

export interface RunResult {
  output: string
  status: RunStatus
  usage: TokenUsage
  turns: number
  /** Files whose contents the worker read (via readFile/grep/listFiles). */
  filesRead: string[]
  /** Files the worker wrote (via writeFile). */
  filesWritten: string[]
  /** Compact one-line summaries of every tool the worker invoked, in order. */
  toolCalls: string[]
  /** `true` when `output` is a runner-synthesized diagnostic template
   *  (`"Sub-agent error: …"`, `"Agent timed out after …"`, the incomplete
   *  template from `buildXxxIncompleteDiagnostic`, etc.) because the
   *  scratchpad was empty at termination. `false` when `output` contains
   *  real model-produced content — either a clean final answer on the
   *  `ok` path, or `scratchpad.latest()` on any salvage path where the
   *  scratchpad had buffered text.
   *
   *  Used by the escalation orchestrator's all-fail fallback to prefer
   *  real content over diagnostic templates regardless of status or
   *  length (otherwise a long `"Sub-agent error: <stack trace>"` string
   *  could beat a shorter genuine partial answer from an earlier
   *  attempt). */
  outputIsDiagnostic: boolean
  /** One entry per provider attempt within this dispatch. Length === 1
   *  for tasks that succeeded on the first try; longer when escalation
   *  occurred. Runners initialize this to `[]`; the escalation
   *  orchestrator populates it on each return path. */
  escalationLog: AttemptRecord[]
  /** Wall-clock duration of this task in milliseconds. */
  durationMs?: number
  /** Directories whose entries the worker listed. */
  directoriesListed?: string[]
  /** Bounded trace of progress events emitted during this task's run. */
  progressTrace?: ProgressTraceEntry[]
  error?: string
  /** Error code for refused briefs. */
  errorCode?: string
  /** Whether the task can be retried. */
  retryable?: boolean
  /** Brief quality warnings from readiness evaluation. */
  briefQualityWarnings?: BriefQualityWarning[]
  /** Worker status extracted from implementer report summary. */
  workerStatus?: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked'
  /** Spec review outcome. */
  specReviewStatus?: 'approved' | 'changes_required' | 'not_run'
  /** Quality review outcome. */
  qualityReviewStatus?: 'approved' | 'changes_required' | 'not_run'
  /** Aggregated structured report from the reviewed execution loop. */
  structuredReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  /** Which agent ran in each role. */
  agents?: {
    normalizer: 'standard' | 'complex' | 'skipped'
    implementer: 'standard' | 'complex' | 'not_run'
    specReviewer: 'standard' | 'complex' | 'not_run'
    qualityReviewer: 'standard' | 'complex' | 'not_run'
  }
  /** The implementer's structured report. */
  implementationReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  /** The spec reviewer's structured report. */
  specReviewReport?: import('./reporting/structured-report.js').ParsedStructuredReport
  /** The quality reviewer's structured report. */
  qualityReviewReport?: import('./reporting/structured-report.js').ParsedStructuredReport
}

/** A captured progress entry, or a synthetic marker when trace trimming occurred. */
export type ProgressTraceEntry =
  | ProgressEvent
  | {
      kind: '_trimmed'
      droppedCount: number
      droppedKinds: Partial<Record<ProgressEvent['kind'], number>>
      capExceededByBoundaryEvents?: boolean
    }

/** Aggregate timing metrics for a `delegate_tasks` batch. */
export interface BatchTimings {
  wallClockMs: number
  sumOfTaskMs: number
  estimatedParallelSavingsMs: number
}

/** Aggregate completion counts for a `delegate_tasks` batch. */
export interface BatchProgress {
  totalTasks: number
  completedTasks: number
  incompleteTasks: number
  failedTasks: number
  successPercent: number
}

/** Aggregate cost metrics for a `delegate_tasks` batch. */
export interface BatchAggregateCost {
  totalActualCostUSD: number
  totalSavedCostUSD: number
  actualCostUnavailableTasks: number
  savedCostUnavailableTasks: number
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
  /** Character count of the canonical orchestrator-side initial brief for
   *  this attempt — the exact string
   *  `${buildSystemPrompt()}\n\n${buildBudgetHint(...)}\n\n${prompt}`
   *  (as assembled before any runner-specific wrapping). Populated by the
   *  escalation orchestrator via the `RunOptions.onInitialRequest` callback
   *  the runner invokes exactly once per attempt.
   *
   *  NOTE: This is a canonical identifier, NOT a wire-level checksum. The
   *  provider's SDK may wrap or transform this string before sending (e.g.
   *  the Anthropic SDK prepends its `claude_code` preset to the system
   *  prompt via `{ type: 'preset', preset: 'claude_code', append: ... }`;
   *  the OpenAI SDKs wrap it in a `messages` array). All three runners use
   *  the same canonical form so the hash is cross-runner stable: identical
   *  briefs produce identical hashes regardless of which runner executed
   *  them. Use this to verify "did the orchestrator send the same brief
   *  across retries?", not "were the literal bytes on the wire identical?".
   *
   *  Defaults to 0 if the runner never invoked the callback. */
  initialPromptLengthChars: number
  /** sha256 hex of the canonical orchestrator-side initial brief. See the
   *  comment on `initialPromptLengthChars` above for the exact hashed
   *  string and the wire-level caveat. Defaults to the empty string if the
   *  runner never invoked the callback. */
  initialPromptHash: string
  /** Why this attempt was abandoned, if it was. Empty if status === 'ok'. */
  reason?: string
  /** Bounded progress trace captured for this attempt, when enabled. */
  progressTrace?: ProgressTraceEntry[]
}

// === Provider (created by createProvider) ===

export interface Provider {
  name: string
  config: ProviderConfig
  run(prompt: string, options?: RunOptions): Promise<RunResult>
}

export interface RunOptions {
  tools?: ToolMode
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
  /** Optional caller-declared output expectations. When supplied, the
   *  supervision layer runs `validateCoverage` after `validateCompletion`'s
   *  syntactic check passes, and re-prompts with specific missing-item
   *  guidance if coverage is insufficient. Same 3-retry budget as other
   *  degeneracy classes. Opt-in: callers who omit this field see zero
   *  change in runner behavior. Generic across all workload shapes that
   *  produce enumerable deliverables. */
  expectedCoverage?: TaskSpec['expectedCoverage']
  /** Opt-out: when true, the runner skips the `no_terminator` and `fragment`
   *  short-output heuristics for this task. Use for tight-format outputs
   *  (single-line verdicts, CSV rows, opaque identifiers) that don't follow
   *  prose conventions. The `empty` and `thinking_only` degeneracy checks
   *  still fire independently. If `expectedCoverage` is also declared and
   *  passes, coverage is authoritative — you don't need this flag. */
  skipCompletionHeuristic?: boolean
  /** Optional callback invoked by runners and the escalation orchestrator to
   *  stream in-flight progress events. See `ProgressEvent` for the full set
   *  of variants. Runners receive this via `provider.run(..., { onProgress })`
   *  and call it synchronously from their loop; the callback MUST NOT throw
   *  and should return quickly. Wired in Task 8 (interface + plumbing);
   *  runners emit events in Tasks 9-11. */
  onProgress?: (event: ProgressEvent) => void
  /** Called exactly once per attempt, when the runner has assembled the
   *  canonical orchestrator-side initial brief — the string
   *  `${buildSystemPrompt()}\n\n${buildBudgetHint(...)}\n\n${prompt}`,
   *  after prevention scaffolding has been produced but before any tool
   *  cycles, re-grounding, supervision, or watchdog injections happen.
   *  The escalation orchestrator passes a closure here to capture the
   *  metadata into the `AttemptRecord` it builds.
   *
   *  This is a canonical identifier, NOT a wire-level checksum: each
   *  runner computes it from the same canonical string so the hash is
   *  cross-runner stable, even though the SDK underneath may wrap the
   *  inputs before sending (Claude prepends its `claude_code` preset to
   *  the system prompt; OpenAI/Codex wrap inputs in structured message
   *  arrays). See `AttemptRecord.initialPromptHash` for the full caveat.
   *
   *  If a runner is re-invoked by escalation, the callback fires again
   *  for the new attempt because the orchestrator resets its per-attempt
   *  closure. Passing nothing keeps existing behaviour (no-op). */
  onInitialRequest?: (meta: { lengthChars: number; sha256: string }) => void
  /** Optional hint about the parent session's model for saved-cost estimates.
   *  When supplied, `RunResult.usage.savedCostUSD` is computed against this
   *  model's profile rates. */
  parentModel?: string
  /** Opt-in: when true, the runner captures every progress event fired
   *  during this task's execution into a bounded, priority-trimmed
   *  `progressTrace` on the final RunResult. Useful for post-hoc
   *  execution observability on long-running delegated tasks. Zero
   *  cost when false (the default). */
  includeProgressTrace?: boolean
  /** Optional cost ceiling in USD. Runner will reject tool calls that would exceed this budget. */
  maxCostUSD?: number
  /** Optional format constraints for input/output. */
  formatConstraints?: FormatConstraints
}

/**
 * Runtime dependencies for `runTasks`. Kept separate from static `MultiModelConfig`
 * because these are per-session objects (today: the context-block store) the
 * caller owns and passes in explicitly, not config loaded from disk.
 */
export interface RunTasksRuntime {
  /** Optional store of registered context blocks. When provided, each task's
   *  `contextBlockIds` are resolved against this store before dispatch; when
   *  omitted, tasks with `contextBlockIds` are passed through unchanged. */
  contextBlockStore?: ContextBlockStore
}

/**
 * In-flight progress signal emitted by runners and the escalation
 * orchestrator. Consumers (today: the MCP cli bridge) translate these into
 * transport-level notifications so callers can observe a sub-agent's work
 * without polling. One `ProgressEvent` per meaningful state transition.
 *
 * Variants mirror spec Part B.1. Runner emission lives in Tasks 9-11; the
 * escalation `escalation_start` hop is emitted by `delegateWithEscalation`
 * itself in Task 8.
 */
export type ProgressEvent =
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
  | { kind: 'done'; status: RunStatus }

// === Routing / Eligibility ===

export type EligibilityFailureCheck =
  | 'capability'
  | 'tier'
  | 'tool_mode'
  | 'provider_not_found'
  | 'unsupported_provider_type'
  | 'missing_required_field'
  | string

export interface EligibilityFailure {
  check: EligibilityFailureCheck
  detail: string
  message: string
}

export interface ProviderEligibility {
  name: string
  config: ProviderConfig
  eligible: boolean
  /** Reasons only present when eligible === false. */
  reasons: EligibilityFailure[]
}

// === Brief Quality ===

export type BriefQualityWarning =
  | 'outsourced_discovery'
  | 'brittle_line_anchors'
  | 'mixed_environment_actions'
  | 'bare_topic_noun'
  | 'no_done_condition'
  | 'no_output_contract'
  | 'tiny_brief'
  | 'huge_brief';

export type BriefQualityPolicy = 'normalize' | 'strict' | 'warn' | 'off' | undefined;

export interface ReadinessResult {
  action: 'refuse' | 'normalize' | 'warn' | 'ignored'
  missingPillars: ('scope' | 'inputs' | 'done_condition' | 'output_contract')[]
  layer2Warnings: BriefQualityWarning[]
  layer3Hints: ('concrete_path' | 'named_code_artifact' | 'reasonable_length')[]
  briefQualityWarnings: BriefQualityWarning[]
}

// === Utilities ===

/**
 * Compute USD cost from token usage and the provider config's optional
 * per-million-token rates. Returns null when either rate is missing — that
 * way the caller can distinguish "we know the cost is zero" (free provider
 * with both rates set to 0) from "we don't know the cost" (rates not
 * configured). Negative or non-finite rates are treated as missing.
 */
export function computeCostUSD(
  inputTokens: number,
  outputTokens: number,
  config: ProviderConfig,
): number | null {
  const explicitRates = resolveRatePair(config.inputCostPerMTok, config.outputCostPerMTok);
  if (explicitRates !== null) {
    return (inputTokens * explicitRates.input + outputTokens * explicitRates.output) / 1_000_000;
  }

  const profile = findModelProfile(config.model);
  const profileRates = resolveRatePair(profile.inputCostPerMTok, profile.outputCostPerMTok);
  if (profileRates === null) {
    return null;
  }

  return (inputTokens * profileRates.input + outputTokens * profileRates.output) / 1_000_000;
}

export function computeSavedCostUSD(
  actualCostUSD: number | null,
  inputTokens: number,
  outputTokens: number,
  parentModel: string | undefined,
): number | null {
  if (actualCostUSD === null || parentModel === undefined) {
    return null;
  }

  const profile = findModelProfile(parentModel);
  const profileRates = resolveRatePair(profile.inputCostPerMTok, profile.outputCostPerMTok);
  if (profileRates === null) {
    return null;
  }

  const hypotheticalParentCostUSD =
    (inputTokens * profileRates.input + outputTokens * profileRates.output) / 1_000_000;
  return hypotheticalParentCostUSD - actualCostUSD;
}

function resolveRatePair(
  inputCostPerMTok: number | undefined,
  outputCostPerMTok: number | undefined,
): { input: number; output: number } | null {
  if (
    inputCostPerMTok !== undefined &&
    outputCostPerMTok !== undefined &&
    Number.isFinite(inputCostPerMTok) &&
    Number.isFinite(outputCostPerMTok) &&
    inputCostPerMTok >= 0 &&
    outputCostPerMTok >= 0
  ) {
    return { input: inputCostPerMTok, output: outputCostPerMTok };
  }
  return null;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
  abort?: AbortController,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => {
      abort?.abort();
      resolve(onTimeout());
    }, timeoutMs);
  });

  return promise
    .then((result) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      return result;
    })
    .catch((error) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      throw error;
    });
}
