// Full type definitions for the codebase's actual RunResult shape.
// Per the v5 wire envelope, this IS the RunResult contract.
// The truth lives here — stage-io.ts ComposePayload is a superset
// used for wire serialization; this file is what runtime code uses.

// ── v4.4 full type definitions ────────────────────────────────────────────────
// These are what the codebase actually uses. assembleRunResult populates every
// field here. delegate-with-escalation.ts and all runner adapters consume them.
// When stage-io.ts ComposePayload is fully wired end-to-end this block can be
// removed in favour of the re-export above.

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
  | 'cost_exceeded'
  | 'time_ceiling'
  | 'degenerate_exhausted'
  | 'api_error'
  | 'provider_transport_failure'
  | 'api_aborted'
  | 'brief_too_vague'
  | 'error';

/** Used inside TurnResult (internal); exported for runner-types.ts alignment. */
export type TurnTerminationReason = _TerminationCause;

export interface TurnResult {
  output: string;
  usage: TokenUsage;
  filesRead: string[];
  filesWritten: string[];
  toolCallsByName: Record<string, number>;
  turns: number;
  durationMs: number;
  costUSD: number;
  /** Raw termination reason from the SDK; may include provider-specific values
   *  beyond the standard _TerminationCause set. assembleRunResult normalizes
   *  via mapStatus/mapTermination before writing to RunResult.terminationReason. */
  terminationReason: string;
  workerSelfAssessment?: string;
  outputIsDiagnostic?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface SessionOpts {
  cwd?: string;
  wallClockDeadline: number;
  idleStallTimeoutMs?: number;
  abortSignal: AbortSignal;
  bus?: object;
}

export interface TurnOpts {
  stageLabel?: string;
}

/** Interface implemented by ClaudeSession and CodexCliSession. */
export interface Session {
  send(instruction: string, opts?: TurnOpts): Promise<TurnResult>;
  close(): Promise<void>;
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

export interface RunResult {
  output: string;
  status: string;
  usage: TokenUsage;
  actualCostUSD: number;
  turns: number;
  filesRead: string[];
  filesWritten: string[];
  toolCalls: string[];
  outputIsDiagnostic: boolean;
  directoriesListed: string[];
  workerStatus?: 'done' | 'failed' | 'blocked';
  terminationReason?: { cause: _TerminationCause; turnsUsed: number; hasFileArtifacts: boolean; usedShell: boolean; workerSelfAssessment: 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' | 'failed' | 'review_loop_capped' | null; wasPromoted: boolean; wallClockMs?: number };
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
  stageStats?: StageStatsShape;
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

/** Minimal shape for stageStats — enough for event-builder.ts to access
 *  stageStats.implementing, stageStats.review, etc. without TS errors.
 *  The full StageStatsMap lives in types/stage-stats.ts. */
export interface StageStatsShape {
  implementing?: RawStageStatsShape;
  review?: RawStageStatsShape & { roundsUsed?: number };
  rework?: RawStageStatsShape;
  annotating?: RawStageStatsShape & { outcome?: string; skipReason?: string };
  committing?: RawStageStatsShape;
}

export interface RawStageStatsShape {
  entered?: boolean;
  durationMs?: number | null;
  costUSD?: number | null;
  agentTier?: string | null;
  modelFamily?: string | null;
  model?: string | null;
  maxIdleMs?: number | null;
  totalIdleMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedNonReadTokens?: number | null;
  turnCount?: number | null;
  toolCallCount?: number | null;
  filesReadCount?: number | null;
  filesWrittenCount?: number | null;
  activityEvents?: number | null;
}