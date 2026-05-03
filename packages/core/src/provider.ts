import type { AgentType, Provider, RunResult, MultiModelConfig, ProviderConfig, ReviewPromptParts, ReviewRunOptions } from './types.js';
import type { RunOptions } from './runners/types.js';
import type { OpenAIRunnerOptions } from './runners/openai-runner.js';

let coreTestProviderOverride: Provider | null = null;
let coreTestProviderOverrideMap: Map<string, Provider> | null = null;

function assertTestProviderEnabled(): void {
  if (process.env.MMAGENT_TEST_PROVIDER_OVERRIDE !== '1') {
    throw new Error('MMAGENT_TEST_PROVIDER_OVERRIDE must be set to 1 to use the test provider override');
  }
}

export function __setCoreTestProviderOverride(provider: Provider | null): void {
  assertTestProviderEnabled();
  coreTestProviderOverride = provider;
}

export function __setCoreTestProviderOverrideMap(map: Map<string, Provider> | null): void {
  assertTestProviderEnabled();
  coreTestProviderOverrideMap = map;
}

export function createProvider(slot: AgentType, config: MultiModelConfig): Provider {
  if (coreTestProviderOverrideMap?.has(slot)) return coreTestProviderOverrideMap.get(slot)!;
  if (coreTestProviderOverride) return coreTestProviderOverride;
  const agentConfig = config.agents[slot];
  if (!agentConfig) {
    throw new Error(`Unknown agent slot: "${slot}". Config must have "standard" and "complex".`);
  }

  const providerConfig = agentConfig as unknown as ProviderConfig;
  const defaults = config.defaults;

  const run = async (prompt: string, options: RunOptions = {}): Promise<RunResult> => {
    try {
      switch (agentConfig.type) {
        case 'codex': {
          const { runCodex } = await import('./runners/codex-runner.js');
          return await runCodex(prompt, options, providerConfig, defaults);
        }

        case 'claude':
        case 'claude-compatible': {
          const { runClaude } = await import('./runners/claude-runner.js');
          return await runClaude(prompt, options, providerConfig, defaults);
        }

        case 'openai-compatible': {
          const { runOpenAI } = await import('./runners/openai-runner.js');
          const { default: OpenAI } = await import('openai');
          const apiKey = agentConfig.apiKey
            ?? (agentConfig.apiKeyEnv ? process.env[agentConfig.apiKeyEnv] : undefined);
          const client = new OpenAI({
            apiKey: apiKey || 'not-needed',
            baseURL: agentConfig.baseUrl,
          });
          const runnerOpts: OpenAIRunnerOptions = { client, providerConfig, defaults };
          return await runOpenAI(prompt, options, runnerOpts);
        }

        default: {
          throw new Error(`Unreachable: unknown provider type`);
        }
      }
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null, costDeltaVsParentUSD: null, cachedTokens: null, reasoningTokens: null },
        turns: 0,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: true,
        escalationLog: [],
        parsedFindings: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const runReview = async (parts: ReviewPromptParts, options: ReviewRunOptions = {}): Promise<RunResult> => {
    try {
      switch (agentConfig.type) {
        case 'codex': {
          const { runCodexReview } = await import('./runners/codex-runner.js');
          return await runCodexReview(parts, options, providerConfig, defaults);
        }

        case 'claude':
        case 'claude-compatible': {
          const { runClaudeReview } = await import('./runners/claude-runner.js');
          return await runClaudeReview(parts, options, providerConfig, defaults);
        }

        case 'openai-compatible': {
          const { runOpenAIReview } = await import('./runners/openai-runner.js');
          const { default: OpenAI } = await import('openai');
          const apiKey = agentConfig.apiKey
            ?? (agentConfig.apiKeyEnv ? process.env[agentConfig.apiKeyEnv] : undefined);
          const client = new OpenAI({
            apiKey: apiKey || 'not-needed',
            baseURL: agentConfig.baseUrl,
          });
          const runnerOpts: OpenAIRunnerOptions = { client, providerConfig, defaults };
          return await runOpenAIReview(parts, options, runnerOpts);
        }

        default: {
          throw new Error(`Unreachable: unknown provider type`);
        }
      }
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null, costDeltaVsParentUSD: null, cachedTokens: null, reasoningTokens: null },
        turns: 0,
        filesRead: [],
        filesWritten: [],
        toolCalls: [],
        outputIsDiagnostic: true,
        escalationLog: [],
        parsedFindings: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return { name: slot, config: providerConfig, run, runReview };
}
