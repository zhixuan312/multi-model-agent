import type { TokenUsage } from '../runners/types.js';
import type { ToolDefinition } from './types.js';

export interface AdapterTurnInput {
  systemPrompt: string;
  userMessage: string;
  priorTurns: unknown[];
  toolDefinitions: ToolDefinition[];
  capabilities: AdapterCapabilities;
}

export interface AdapterTurnResult {
  assistantText: string;
  toolCalls: { name: string; input: unknown }[];
  usage: TokenUsage;
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
  turn(input: AdapterTurnInput): Promise<AdapterTurnResult>;
}
