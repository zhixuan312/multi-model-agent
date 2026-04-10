// === Tier & Capability ===

export type Tier = 'trivial' | 'standard' | 'reasoning';
export type Capability = 'file_read' | 'file_write' | 'grep' | 'glob' | 'shell' | 'web_search' | 'web_fetch';
export type ToolMode = 'none' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type RunStatus = 'ok' | 'error' | 'timeout' | 'max_turns';

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
  files: string[]
  error?: string
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
}

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
