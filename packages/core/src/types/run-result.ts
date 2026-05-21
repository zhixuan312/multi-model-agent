// Full type definitions for the codebase's actual run-time result shapes.
//
// ── PLAN TASK 2 — RunResult IS ComposePayload ─────────────────────────────
// Per the stage-io-standardization plan, `RunResult` is the v5 wire envelope
// (= ComposePayload from stage-io.ts). The internal lifecycle data flow
// (what runners produce, what `state.lastRunResult` holds, what the
// recorder/event-builder reads) uses a separate type — `RuntimeRunResult`
// (declared below) — kept distinct from the wire envelope.
//
// Consumer rule:
//   - Anywhere code is reading the BATCH/WIRE-side result → `RunResult`
//     (= ComposePayload — 8 fields).
//   - Anywhere code is reading the RUNTIME mirror (workerStatus, stageStats,
//     usage, terminationReason, …) → `RuntimeRunResult`.
//
// Drift detector lives at `tests/types/run-result.test.ts`.
// ──────────────────────────────────────────────────────────────────────────

export type { ComposePayload as RunResult } from '../lifecycle/stage-io.js';
import type { TaskEnvelopeStore } from '../events/task-envelope.js';
import type { StageStatsMap } from './stage-stats.js';

// ── Runtime mirror — what the SDK runners + lifecycle internally produce ─────
// `RuntimeRunResult` is the v4 fat shape. Renamed from `RunResult` so the
// public type name is the wire envelope; the runtime mirror keeps the
// fields handlers/recorder/runners actually populate.

// Session / TurnResult — the internal provider-runner contract (SDK ↔ mma)

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedNonReadTokens: number;
}

/** Cause values for the TerminationReason object (inline to break circularity). */
export type _TerminationCause =
  | 'finished'
  | 'incomplete'
  | 'timeout'
  | 'time_ceiling'
  | 'degenerate_exhausted'
  | 'brief_too_vague'
  | 'error';

/** Used inside TurnResult (internal); exported for runner-types.ts alignment. */
export type TurnTerminationReason = _TerminationCause;

export interface TurnResult {
  output: string;
  usage: TokenUsage;
  costUSD: number;
  turns: number;
  durationMs: number;
  terminationReason: 'ok' | 'error' | 'time_exceeded' | 'cap_exhausted' | 'stalled' | 'aborted';
  errorCode?: string;
  filesWritten: string[];
  usedShell: boolean;
}

export interface SessionOpts {
  cwd?: string;
  wallClockDeadline: number;
  idleStallTimeoutMs?: number;
  abortSignal: AbortSignal;
  bus?: object;
  /** Task identity — required for per-task event tagging so the stall watchdog
   *  can filter the shared bus. Optional only because some unit tests construct
   *  sessions directly without a task context. */
  batchId?: string;
  /** Index within batch. */
  taskIndex?: number;
  /** Per-task event envelope for recording provider mutations. Optional during wiring phase. */
  envelope?: TaskEnvelopeStore;
}

export interface TurnOpts {
  stageLabel?: string;
  /** Cooperative cancellation — pass the per-task stall abort signal so
   *  send() can be unwound by the stuck-detection watchdog. */
  signal?: AbortSignal;
}

/** Interface implemented by ClaudeSession and CodexCliSession. */
export interface Session {
  send(instruction: string, opts?: TurnOpts): Promise<TurnResult>;
  close(): Promise<void>;
  /** Returns the OS pid of the active CLI subprocess if one exists. Undefined
   *  between turns or for providers that do not spawn a child (e.g. in-process
   *  SDK clients). Used by shutdown drain to SIGKILL stragglers. */
  getPid?(): number | undefined;
}

// Provider — factory-created handle that openSession returns

export interface Provider {
  name: string;
  /** Provider config — shape varies by runtime (ClaudeProviderConfig | CodexProviderConfig).
   *  Consumers access .type and .model via unsafe downcasts; the full type lives
   *  in types/config.ts to avoid circular deps. */
  config: any;     // v5: ClaudeProviderConfig | CodexProviderConfig (lives in types/config.ts; broadened to avoid circular dep)
  openSession(opts: SessionOpts): Session;
}

// RunResult — what lifecycle handlers and delegate-with-escalation consume
// Fields are derived from live usage across event-builder, delegate-with-escalation,
// task-runner, task-executor, task-completion-summary, review-verdict-mapping,
// fallback-helpers, and assemble-run-result.

export interface RuntimeRunResult {
  output: string;
  status: string;
  usage: TokenUsage;
  actualCostUSD: number;
  turns: number;
  filesWritten: string[];
  outputIsDiagnostic: boolean;
  directoriesListed: string[];
  workerStatus?: 'done' | 'failed' | 'blocked';
  terminationReason?: { cause: _TerminationCause; turnsUsed: number; hasFileArtifacts: boolean; usedShell: boolean; workerSelfAssessment: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_capped' | null; wasPromoted: boolean; wallClockMs?: number };
  usedShell?: boolean;
  errorCode?: string;
  error?: string;
  retryable?: boolean;
  incompleteReason?: string;
  escalationLog: EscalationRecord[];
  // ── event-builder.ts ─────────────────────────────────────────────────────
  durationMs?: number;
  models?: {
    implementer?: string;
    reviewer?: string;
    [key: string]: string | undefined;
  };
  agents?: {
    implementer?: string;
    implementerToolMode?: string;
    fallbackOverrides?: Array<{ role: string; assigned: string }>;
    [key: string]: unknown;
  };
  stageStats?: Partial<StageStatsMap>;
  reviewVerdict?: string;
  qualityReviewStatus?: string;
  specReviewStatus?: string;
  reviewRounds?: { spec: number; quality: number };
  structuredReport?: {
    findings?: Array<{ severity?: string; category?: string; claim?: string }>;
    reviewConcerns?: string[];
  };
  implementationReport?: unknown;
  commits?: Array<{ filesChanged?: string[] }>;
  stallCount?: number;
  stallTriggered?: boolean;
  taskMaxIdleMs?: number;
  structuredError?: { code: string; message: string; where?: string };
  // ── review-verdict-mapping.ts ────────────────────────────────────────────
  verifyResult?: unknown;
  // ── task-executor.ts ─────────────────────────────────────────────────────
  cost?: { costUSD: number | null; costDeltaVsMainUSD: number | null };
  // ── delegate-with-escalation.ts ─────────────────────────────────────────
}

export interface EscalationRecord {
  provider: string;
  status: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
  initialPromptLengthChars: number;
  initialPromptHash: string;
  reason?: string;
}

// Supporting types re-exported through types.ts barrel

export interface Commit {
  sha: string;
  message: string;
  files: string[];
  authoredAt: string;
}

export interface ReviewPromptParts {
  specPortion?: string;
  codePortion?: string;
  rubricPortion?: string;
}

export interface CacheHints {
  cacheableSystemPrompt?: boolean;
}

export interface ReviewRunOptions {
  mode?: 'standard' | 'review';
  instructionsSuffix?: string;
  cacheHints?: CacheHints;
  abortSignal?: AbortSignal;
}

