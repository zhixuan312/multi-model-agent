// v4.4 — Test-bridge adapter type. Production code no longer uses
// adapters; provider.openSession() returns a Session directly. The
// `RunnerAdapter` type survives only so legacy test fixtures
// (tests/contract/fixtures/mock-providers.ts → mockAdapter) can keep
// emitting one canned turn at a time through bootstrap's
// `adapterToFakeSession` bridge. New tests should mock Session directly.

import type { TokenUsage } from '../providers/runner-types.js';

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
