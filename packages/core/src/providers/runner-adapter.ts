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
}

export interface AdapterTurnResult {
  assistantText: string;
  toolCalls: { name: string; input: unknown }[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
  errorCode?: string;
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
