// Shared RunnerAdapter interface — see docs/refactor/runner-adapter-matrix.md
// for the per-provider derivation. Chapter 4 of the refactor plan unifies
// openai-runner / claude-runner / codex-runner behind this adapter.
import type { InternalRunnerEvent, RunOptions } from '../types.js';
import type { ProviderConfig, SandboxPolicy, ToolMode } from '../../types.js';
import type { FileTracker } from '../../tools/tracker.js';
import type { ToolImplementations } from '../../tools/definitions.js';

export interface NormalizedProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests?: number;
  costUSD?: number | null;
}

export interface NormalizedProviderToolCall {
  id: string;
  name: string;
  argumentsText: string;
  /** Diagnostic/replay escape valve. Not a shared-policy escape hatch. */
  raw?: unknown;
}

export interface NormalizedProviderTurn<ProviderTurn, ProviderUsage> {
  raw: ProviderTurn;
  text: string;
  usage: ProviderUsage;
  normalizedUsage: NormalizedProviderUsage;
  toolCalls: NormalizedProviderToolCall[];
  finishReason?: string;
  providerStatus?: string;
}

export interface RunnerAdapter<ProviderTurn, ProviderUsage> {
  readonly providerLabel: 'openai-compatible' | 'claude' | 'codex' | string;

  createInitialState(args: {
    promptWithBudgetHint: string;
    systemPrompt: string;
    options: RunOptions;
    providerConfig: ProviderConfig;
    defaults: { timeoutMs: number; tools: ToolMode };
    tracker: FileTracker;
    toolImpls: ToolImplementations;
    sandboxPolicy: SandboxPolicy;
    abortController: AbortController;
    emit: (event: InternalRunnerEvent) => void;
  }): Promise<void> | void;

  nextTurn(): Promise<NormalizedProviderTurn<ProviderTurn, ProviderUsage>>;

  sendUserMessage(text: string): Promise<void> | void;

  /** Codex executes + replays tool calls manually; OpenAI/Claude rely on their SDK. */
  executeToolCall?(call: NormalizedProviderToolCall): Promise<string>;

  appendToolResult?(call: NormalizedProviderToolCall, result: string): Promise<void> | void;

  getPartialUsage(): NormalizedProviderUsage;

  abort(reason?: string): Promise<void> | void;
}
