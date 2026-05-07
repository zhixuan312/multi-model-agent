import type { TokenUsage } from '../providers/runner-types.js';
import type { ToolDefinition } from './runner-shell-types.js';

export interface AdapterTurnRecord {
  assistantText: string;
  toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
}

export interface AdapterTurnInput {
  systemPrompt: string;
  userMessage: string;
  priorTurns: AdapterTurnRecord[];
  toolDefinitions: ToolDefinition[];
  capabilities: AdapterCapabilities;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
}

export interface AdapterTurnResult {
  assistantText: string;
  toolCalls: { name: string; input: unknown }[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
  errorCode?: string;
  /** Provider-side response shape for verbose diagnostics. Adapters report
   *  the raw stop_reason and a count of each content block type so the
   *  runner-shell can emit a `runner_response_received` event when the
   *  bus is wired. Lets operators see e.g. `{ text: 0, thinking: 1 }`
   *  when a provider returns reasoning-only and no narrative — the
   *  signature failure mode that produced silent empty output in 4.0.x. */
  responseShape?: {
    stopReason?: string;
    contentBlocks?: Record<string, number>;
  };
}

export interface AdapterCapabilities {
  cache_control: boolean;
  thinking: boolean;
  vision: boolean;
  tool_use: boolean;
  streaming: boolean;
  other: string[];
}

export interface RunnerAdapter {
  readonly providerType: 'claude' | 'claude-compatible' | 'openai' | 'openai-compatible' | 'codex';
  turn(input: AdapterTurnInput): Promise<AdapterTurnResult>;
}
