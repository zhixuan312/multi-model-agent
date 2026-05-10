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
  /** Identifies which task within a batch is running. Carried through to
   *  every emitted event so polling can show per-task progress when a
   *  batch has multiple parallel tasks. */
  taskIndex?: number;
  /** Tier label (`'standard'` | `'complex'`) included in emitted events. */
  tier?: string;
  /** Provider model id included in emitted events. */
  model?: string;
  /** Lifecycle stage label (e.g. 'Implementing', 'Spec review'). Surfaced
   *  on the running-headline polling response so the main agent's poll
   *  loop shows which lifecycle stage is currently active. */
  stageLabel?: string;
  /** When set, ask the provider to attach a cache_control marker to the
   *  system prompt so the prefix can be reused by subsequent calls.
   *  Honored by adapters that expose explicit cache control (Anthropic);
   *  no-op on adapters that auto-cache (OpenAI) or don't cache (codex). */
  cacheControl?: { type: 'ephemeral' };
}

export interface RunResult {
  workerStatus: WorkerStatus;
  finalAssistantText: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  errorCode?: ErrorCode;
  /** Number of LLM turns executed (one per adapter.turn() call). Distinct
   *  from toolCalls.length — a turn can return multiple tool calls or none. */
  turns: number;
  /** Wall-clock for the entire shell.run() invocation. */
  durationMs: number;
  /** Files read during this run (paths from successful read_file/readFile tool calls). */
  filesRead: string[];
  /** Files written during this run (paths from successful write_file/writeFile/edit_file tool calls). */
  filesWritten: string[];
  /** USD cost computed from usage tokens and the model's rate card.
   *  null when the model isn't in the rate-card registry (treated as honest-null
   *  by the wire, not zero). */
  costUSD: number | null;
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
