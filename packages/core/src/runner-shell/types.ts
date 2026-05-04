import type { TokenUsage } from '../runners/types.js';

export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed';

export interface RunInput {
  systemPrompt: string;
  userMessage: string;
  toolDefinitions: ToolDefinition[];
  maxTurns: number;
  cwd: string;
  capabilities?: import('./adapter.js').AdapterCapabilities;
}

export interface RunResult {
  workerStatus: WorkerStatus;
  finalAssistantText: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  errorCode?: ErrorCode;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: object;
  execute(input: unknown, ctx: ExecutionContext): Promise<unknown>;
}

export interface ExecutionContext {
  cwd: string;
  callCache: Map<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: unknown;
  result?: unknown;
  id?: string;
}

export type ErrorCode = string;
