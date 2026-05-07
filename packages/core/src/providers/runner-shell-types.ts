import type { TokenUsage } from './runner-types.js';
import type { EventEmitter } from '../events/event-emitter.js';

export type WorkerStatus = 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed';

export interface RunInput {
  systemPrompt: string;
  userMessage: string;
  toolDefinitions: ToolDefinition[];
  maxTurns: number;
  cwd: string;
  capabilities?: import('./runner-adapter.js').AdapterCapabilities;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  /** Bus for per-turn / per-runner-call observability events. When present,
   *  shell + adapter emit `runner_turn_started` / `runner_response_received`
   *  / `runner_turn_completed` events so VerboseLogChannel surfaces them
   *  on stderr in real time during a long task run. */
  bus?: EventEmitter;
  /** Identifies the in-flight batch in emitted events. */
  batchId?: string;
  /** Tier label (`'standard'` | `'complex'`) included in emitted events. */
  tier?: string;
  /** Provider model id included in emitted events. */
  model?: string;
  /** Lifecycle stage label (e.g. 'Implementing', 'Spec review'). Surfaced
   *  on the running-headline polling response so the main agent's poll
   *  loop shows which lifecycle stage is currently active. */
  stageLabel?: string;
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
