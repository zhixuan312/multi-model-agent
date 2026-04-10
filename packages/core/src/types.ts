// === Tier & Capability ===

export type Tier = 'trivial' | 'standard' | 'reasoning';
export type Capability = 'file_read' | 'file_write' | 'grep' | 'glob' | 'shell' | 'web_search' | 'web_fetch';
export type ToolMode = 'none' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
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
  | 'error';

// === Task ===

export interface TaskSpec {
  prompt: string
  /** Provider name. If omitted, core auto-selects. */
  provider?: string
  tier: Tier
  requiredCapabilities: Capability[]
  tools?: ToolMode
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
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
  defaults: {
    maxTurns: number
    timeoutMs: number
    tools: ToolMode
  }
}

// === Result ===

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUSD: number | null
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
  /** One entry per provider attempt within this dispatch. Length === 1
   *  for tasks that succeeded on the first try; longer when escalation
   *  occurred. Runners initialize this to `[]`; the escalation
   *  orchestrator populates it on each return path. */
  escalationLog: AttemptRecord[]
  error?: string
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
  /** Character count of the very first request body sent to the provider on
   *  this attempt. Populated by Task 12 via `RunOptions.onInitialRequest`; for
   *  now this is always 0. */
  initialPromptLengthChars: number
  /** sha256 hex of the same first request body. Populated by Task 12; for now
   *  this is always the empty string. */
  initialPromptHash: string
  /** Why this attempt was abandoned, if it was. Empty if status === 'ok'. */
  reason?: string
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
  /** Optional callback invoked by runners and the escalation orchestrator to
   *  stream in-flight progress events. See `ProgressEvent` for the full set
   *  of variants. Runners receive this via `provider.run(..., { onProgress })`
   *  and call it synchronously from their loop; the callback MUST NOT throw
   *  and should return quickly. Wired in Task 8 (interface + plumbing);
   *  runners emit events in Tasks 9-11. */
  onProgress?: (event: ProgressEvent) => void
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
  const inRate = config.inputCostPerMTok;
  const outRate = config.outputCostPerMTok;
  if (
    inRate === undefined || outRate === undefined ||
    !Number.isFinite(inRate) || !Number.isFinite(outRate) ||
    inRate < 0 || outRate < 0
  ) {
    return null;
  }
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
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
