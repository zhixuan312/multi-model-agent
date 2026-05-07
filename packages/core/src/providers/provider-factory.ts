import type { AgentType, Provider, RunResult, MultiModelConfig, ProviderConfig } from '../types.js';
import type { RunOptions } from './runner-types.js';
import { RunnerShell } from './runner-shell.js';
import { AnthropicMessagesAdapter } from './anthropic-messages-adapter.js';
import { OpenAIChatAdapter } from './openai-chat-adapter.js';
import { OpenAIResponsesAdapter } from './openai-responses-adapter.js';
import { makeToolDefinitions } from './tool-definitions.js';
import type { RunnerAdapter } from './runner-adapter.js';

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

export function buildAdapter(agentConfig: {
  type: 'openai-compatible' | 'claude' | 'claude-compatible' | 'codex';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}): RunnerAdapter {
  const apiKey = agentConfig.apiKey
    ?? (agentConfig.apiKeyEnv ? process.env[agentConfig.apiKeyEnv] : undefined);
  const maxOutputTokens = 4096;

  switch (agentConfig.type) {
    case 'claude':
    case 'claude-compatible':
      return new AnthropicMessagesAdapter({
        apiKey: apiKey || 'not-needed',
        baseURL: agentConfig.baseUrl,
        model: agentConfig.model,
        maxOutputTokens,
        providerType: agentConfig.type,
      });
    case 'openai-compatible':
      return new OpenAIChatAdapter({
        apiKey: apiKey || 'not-needed',
        baseURL: agentConfig.baseUrl,
        model: agentConfig.model,
        maxOutputTokens,
        providerType: 'openai-compatible',
      });
    case 'codex':
      return new OpenAIResponsesAdapter({
        apiKey: apiKey || 'not-needed',
        baseURL: agentConfig.baseUrl,
        model: agentConfig.model,
        maxOutputTokens,
      });
  }
}

const SYSTEM_PROMPT = [
  'You are a software engineering agent with access to file-system and shell tools.',
  'Work step-by-step. Read files before editing them.',
  'When you have completed the task, produce a final answer summarizing what you did.',
].join('\n');

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
      const cwd = options.cwd ?? process.cwd();
      const toolMode = options.tools ?? defaults.tools ?? 'full';
      const maxTurns = 50;

      const toolDefinitions = toolMode !== 'none'
        ? makeToolDefinitions({ cwd })
        : [];

      const effectiveSystemPrompt = options.instructionsSuffix
        ? `${SYSTEM_PROMPT}\n\n${options.instructionsSuffix}`
        : SYSTEM_PROMPT;

      const adapter = buildAdapter(agentConfig);
      const shell = new RunnerShell(adapter);

      const result = await shell.run({
        systemPrompt: effectiveSystemPrompt,
        userMessage: prompt,
        toolDefinitions,
        maxTurns,
        cwd,
      });

      const toolCallSummaries = result.toolCalls.map(tc => {
        const inputPreview = typeof tc.input === 'object' && tc.input !== null
          ? JSON.stringify(tc.input).slice(0, 120)
          : String(tc.input ?? '').slice(0, 120);
        return `${tc.name}(${inputPreview})`;
      });

      return {
        output: result.finalAssistantText,
        status: result.workerStatus === 'done' ? 'ok' : 'incomplete',
        usage: result.usage,
        turns: result.toolCalls.length,
        filesRead: [],
        filesWritten: [],
        toolCalls: toolCallSummaries,
        outputIsDiagnostic: false,
        escalationLog: [],
        parsedFindings: null,
        workerStatus: result.workerStatus,
        errorCode: result.errorCode,
      };
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
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

  return { name: slot, config: providerConfig, run };
}
