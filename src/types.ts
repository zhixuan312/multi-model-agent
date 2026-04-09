export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number | null;
}

export type ToolMode = 'none' | 'full';

export type SandboxPolicy = 'none' | 'cwd-only';

export type RunStatus = 'ok' | 'error' | 'timeout' | 'max_turns';

export interface RunResult {
  output: string;
  status: RunStatus;
  usage: TokenUsage;
  turns: number;
  files: string[];
  error?: string;
}

export interface RunOptions {
  tools?: ToolMode;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  effort?: string;
  sandboxPolicy?: SandboxPolicy;
}

export type Tier = 'trivial' | 'standard' | 'reasoning';

export type CostTier = 'free' | 'low' | 'medium' | 'high';

export type Capability =
  | 'file_read'
  | 'file_write'
  | 'grep'
  | 'glob'
  | 'shell'
  | 'web_search'
  | 'web_fetch';

export type ProviderType = 'codex' | 'claude' | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  effort?: string;
  maxTurns?: number;
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  sandboxPolicy?: SandboxPolicy;
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
  costTier?: CostTier;
}

export interface MultiModelConfig {
  providers: Record<string, ProviderConfig>;
  defaults: {
    maxTurns: number;
    timeoutMs: number;
    tools: ToolMode;
  };
}

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfig;
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
}

export interface DelegateTask {
  provider: Provider;
  prompt: string;
  tier: Tier;
  requiredCapabilities: Capability[];
  tools?: ToolMode;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  effort?: string;
  sandboxPolicy?: SandboxPolicy;
}

export interface PartialProgress {
  files: string[];
  usage?: Partial<TokenUsage>;
  turns?: number;
}

export async function withTimeout(
  promise: Promise<RunResult>,
  timeoutMs: number,
  partialProgress: () => PartialProgress,
  abortController?: AbortController,
): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      abortController?.abort();
      const progress = partialProgress();
      resolve({
        output: 'Agent timed out.',
        status: 'timeout',
        usage: {
          inputTokens: progress.usage?.inputTokens ?? 0,
          outputTokens: progress.usage?.outputTokens ?? 0,
          totalTokens: progress.usage?.totalTokens ?? 0,
          costUSD: progress.usage?.costUSD ?? null,
        },
        turns: progress.turns ?? 0,
        files: progress.files,
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
