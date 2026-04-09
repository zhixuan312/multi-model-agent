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

export type ProviderType = 'codex' | 'claude' | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  effort?: string;
  maxTurns?: number;
  timeoutMs?: number;
  baseUrl?: string;
  apiKeyEnv?: string;
  sandboxPolicy?: SandboxPolicy;
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
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
  tools?: ToolMode;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  effort?: string;
  sandboxPolicy?: SandboxPolicy;
}

export async function withTimeout(
  promise: Promise<RunResult>,
  timeoutMs: number,
  partialFiles: () => string[],
  abortController?: AbortController,
): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      abortController?.abort();
      resolve({
        output: 'Agent timed out.',
        status: 'timeout',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        files: partialFiles(),
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
