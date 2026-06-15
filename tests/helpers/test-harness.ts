import type { TokenUsage } from '../../packages/core/src/providers/runner-types.js';

export interface AdapterTurnRecord {
  assistantText: string;
  toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
}

export interface AdapterTurnInput {
  systemPrompt: string;
  userMessage: string;
  priorTurns: AdapterTurnRecord[];
  toolDefinitions: unknown[];
  capabilities: AdapterCapabilities;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  bus?: { emit: (event: Record<string, unknown>) => void };
  cwd?: string;
}

export interface AdapterTurnResult {
  assistantText: string;
  toolCalls: { name: string; input: unknown }[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
  errorCode?: string;
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
  readonly providerType: 'claude' | 'codex' | 'mock';
  turn(input: AdapterTurnInput): Promise<AdapterTurnResult>;
}
