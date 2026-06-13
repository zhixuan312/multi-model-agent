// Run-result types.
//
// `RunResult` — the wire envelope shape (unified handler response).
// `RuntimeRunResult` — the internal fat shape for test mock providers.

export type RunResult = {
  completed: boolean;
  message: string;
  findings: Array<{ id?: string; severity: string; category: string; claim: string; evidence?: string; suggestion?: string; source: string }>;
  summary: string;
  filesChanged: string[];
  commitSha: string | null;
  blockId: string | null;
  findingsOutcome?: 'found' | 'clean' | 'not_applicable';
  findingsOutcomeReason?: string | null;
  outcomeInferred?: boolean;
  outcomeMalformed?: boolean;
  telemetry: {
    totalDurationMs: number;
    totalCostUSD: number | null;
    workerSelfAssessment: 'done' | 'failed' | null;
    reviewVerdict: 'approved' | 'changes_required' | null;
    commitOutcome: 'committed' | 'no_op' | 'not_applicable';
    stopReason: 'normal' | 'turn_cap' | 'timeout' | 'transport_error';
    haltedStage: string | null;
    stages: Array<{
      name: string;
      outcome: 'advance' | 'skip' | 'halt' | 'not_run';
      comment?: string;
      durationMs: number;
      costUSD: number | null;
    }>;
  };
};

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

/** Resolved + staged skills for a worker session. `stagedRoot` contains a
 *  `skills/<name>/` subtree per requested skill (the same layout Codex reads
 *  at `$CODEX_HOME/skills` and the Claude plugin references as `./skills/<name>`). */
export interface ResolvedSkillBundle {
  stagedRoot: string;
  names: string[];
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
  taskId?: string;
  /** Index within task. */
  taskIndex?: number;
  /** Per-task event envelope for recording provider mutations. Optional during wiring phase. */
  envelope?: TaskEnvelopeStore;
  /** Present only when the task requested skills and resolution succeeded. */
  skills?: ResolvedSkillBundle;
}

export interface TurnOpts {
  stageLabel?: string;
  /** Cooperative cancellation — pass the per-task stall abort signal so
   *  send() can be unwound by the stuck-detection watchdog. */
  signal?: AbortSignal;
  /** Goal condition — when set, a Stop hook evaluates this condition after
   *  each turn. If not met, the agent continues working. Claude SDK only
   *  (Codex exec does not support programmatic goal evaluation). */
  goalCondition?: string;
}

/** Interface implemented by ClaudeSession and CodexCliSession. */
export interface Session {
  send(instruction: string, opts?: TurnOpts): Promise<TurnResult>;
  close(): Promise<void>;
  /** Returns the OS pid of the active CLI subprocess if one exists. Undefined
   *  between turns or for providers that do not spawn a child (e.g. in-process
   *  SDK clients). Used by shutdown drain to SIGKILL stragglers. */
  getPid?(): number | undefined;
  /** Returns the provider-assigned session/thread ID if one has been captured
   *  (i.e. after the first successful send()). Null before any send or if the
   *  provider never assigns an ID. Used by the unified task API to expose
   *  session identity on the wire. */
  getSessionId(): string | null;
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
  verifyResult?: unknown;
  cost?: { costUSD: number | null; costDeltaVsMainUSD: number | null };
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


