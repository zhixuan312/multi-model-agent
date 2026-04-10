import type { Provider, RunResult, RunOptions, MultiModelConfig, ProviderConfig } from './types.js';
import type { OpenAIRunnerOptions } from './runners/openai-runner.js';

export function createProvider(name: string, config: MultiModelConfig): Provider {
  const providerConfig = config.providers[name];
  if (!providerConfig) {
    const available = Object.keys(config.providers).sort().join(', ');
    throw new Error(`Provider "${name}" not found in config. Available: ${available}`);
  }

  const defaults = config.defaults;

  const run = async (prompt: string, options: RunOptions = {}): Promise<RunResult> => {
    try {
      switch (providerConfig.type) {
        case 'codex': {
          const { runCodex } = await import('./runners/codex-runner.js');
          return await runCodex(prompt, options, providerConfig, defaults);
        }

        case 'claude': {
          const { runClaude } = await import('./runners/claude-runner.js');
          return await runClaude(prompt, options, providerConfig, defaults);
        }

        case 'openai-compatible': {
          const { runOpenAI } = await import('./runners/openai-runner.js');
          const { default: OpenAI } = await import('openai');
          const apiKey = providerConfig.apiKey
            ?? (providerConfig.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined);
          const client = new OpenAI({
            apiKey: apiKey || 'not-needed',
            baseURL: providerConfig.baseUrl,
          });
          const runnerOpts: OpenAIRunnerOptions = { client, providerConfig, defaults };
          return await runOpenAI(prompt, options, runnerOpts);
        }

        default: {
          // All provider types are handled above; this is a type safety net.
          throw new Error(`Unreachable: unknown provider type`);
        }
      }
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        // Fallback error wrapper around a thrown runner — no scratchpad
        // involved, just the raw error message.
        outputIsDiagnostic: true,
        escalationLog: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return { name, config: providerConfig, run };
}
