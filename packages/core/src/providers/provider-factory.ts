import type { AgentType, Provider, RunResult, MultiModelConfig, ProviderConfig } from '../types.js';
import type { RunOptions } from './runner-types.js';
import { RunnerShell } from './runner-shell.js';
import { AnthropicMessagesAdapter } from './anthropic-messages-adapter.js';
import { OpenAIChatAdapter } from './openai-chat-adapter.js';
import { OpenAIResponsesAdapter } from './openai-responses-adapter.js';
import { makeToolDefinitions } from './tool-definitions.js';
import type { RunnerAdapter } from './runner-adapter.js';
import { getCodexAuth } from '../identity/auth-token-store.js';
import { SAFETY_MAX_TURNS } from '../bounded-execution/safety-max-turns.js';

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

// No output-token caps anywhere — the only worker bounds are the
// task-level wall-clock deadline and (when set) the per-task cost
// ceiling. OpenAI Chat + Responses adapters omit max_tokens entirely
// so the model uses its full output budget. Anthropic Messages
// **requires** max_tokens per API spec, so we pass a value high
// enough to never bite in practice (matches the largest documented
// ceiling across the Claude family). If a model accepts less, the
// API rejects loudly — easier to triage than a silent truncation,
// which is the failure mode 4.0.x hit at the 4096 default when
// deepseek-v4-pro burned its budget on a thinking block.
const ANTHROPIC_MAX_TOKENS_REQUIRED = 64000;

export function buildAdapter(agentConfig: {
  type: 'openai-compatible' | 'claude' | 'claude-compatible' | 'codex';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}): RunnerAdapter {
  const apiKey = agentConfig.apiKey
    ?? (agentConfig.apiKeyEnv ? process.env[agentConfig.apiKeyEnv] : undefined);

  switch (agentConfig.type) {
    case 'claude':
    case 'claude-compatible':
      return new AnthropicMessagesAdapter({
        apiKey: apiKey || 'not-needed',
        baseURL: agentConfig.baseUrl,
        model: agentConfig.model,
        maxOutputTokens: ANTHROPIC_MAX_TOKENS_REQUIRED,
        providerType: agentConfig.type,
      });
    case 'openai-compatible':
      return new OpenAIChatAdapter({
        apiKey: apiKey || 'not-needed',
        baseURL: agentConfig.baseUrl,
        model: agentConfig.model,
        providerType: 'openai-compatible',
      });
    case 'codex': {
      // Prefer ChatGPT/Codex OAuth (~/.codex/auth.json) — this is how
      // users who logged in via `codex` CLI authenticate. Without it, the
      // request hits api.openai.com with a placeholder key and 401s. If
      // OAuth is missing, fall back to whatever apiKey the user supplied
      // (so the codex type can also be pointed at api.openai.com with a
      // real key, or any other OpenAI-Responses-compatible endpoint).
      const oauth = getCodexAuth();
      if (oauth && !apiKey && !agentConfig.baseUrl) {
        return new OpenAIResponsesAdapter({
          apiKey: oauth.accessToken,
          baseURL: 'https://chatgpt.com/backend-api/codex',
          model: agentConfig.model,
          defaultHeaders: { 'chatgpt-account-id': oauth.accountId },
        });
      }
      return new OpenAIResponsesAdapter({
        apiKey: apiKey || 'not-needed',
        baseURL: agentConfig.baseUrl,
        model: agentConfig.model,
      });
    }
  }
}

const SYSTEM_PROMPT = [
  'You are a software engineering agent with access to file-system and shell tools.',
  'Work step-by-step. Read files before editing them.',
  // Tool sweep #6: the spec / quality / diff reviewer stages now see the
  // cumulative diff against the pre-task baseline. The implementer no
  // longer needs to verify its own edits — the reviewers will check the
  // actual change. Skipping post-edit re-reads typically saves 4-6
  // minutes per task on slow models.
  'Trust edit_file/write_file: if the tool returns without an error, the edit applied. Do NOT re-read a file just to verify your own successful edit.',
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
      const maxTurns = SAFETY_MAX_TURNS;

      const toolDefinitions = toolMode !== 'none'
        ? makeToolDefinitions({ cwd })
        : [];

      const effectiveSystemPrompt = options.instructionsSuffix
        ? `${SYSTEM_PROMPT}\n\n${options.instructionsSuffix}`
        : SYSTEM_PROMPT;

      const adapter = buildAdapter(agentConfig);
      const shell = new RunnerShell(adapter, providerConfig.model);

      const result = await shell.run({
        systemPrompt: effectiveSystemPrompt,
        userMessage: prompt,
        toolDefinitions,
        maxTurns,
        cwd,
        ...(options.abortSignal && { abortSignal: options.abortSignal }),
        ...(options.bus && { bus: options.bus }),
        ...(options.batchId !== undefined && { batchId: options.batchId }),
        ...(options.taskIndex !== undefined && { taskIndex: options.taskIndex }),
        ...(options.tier !== undefined && { tier: options.tier }),
        ...(options.stageLabel !== undefined && { stageLabel: options.stageLabel }),
        model: providerConfig.model,
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
        turns: result.turns,
        durationMs: result.durationMs,
        filesRead: result.filesRead,
        filesWritten: result.filesWritten,
        toolCalls: toolCallSummaries,
        outputIsDiagnostic: false,
        escalationLog: [],
        parsedFindings: null,
        workerStatus: result.workerStatus,
        errorCode: result.errorCode,
        ...(result.costUSD !== null && {
          cost: { costUSD: result.costUSD, costDeltaVsMainUSD: null },
        }),
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
