import type {
  Provider,
  TaskSpec,
  MultiModelConfig,
  AgentType,
} from '../types.js';
import type { Session } from '../types/run-result.js';
import type { EnvelopeBus } from '../events/envelope-bus.js';
import type { ActivityTracker, HeartbeatTickInfo } from '../bounded-execution/activity-tracker.js';
import type { WallClockGuard } from '../bounded-execution/wall-clock-guard.js';
import type { CanonicalIdentity } from '../config/canonical-model-identity.js';

import type { ProjectContext } from '../stores/project-context-registry.js';
import type { ContextBlockStore } from '../stores/context-block-tool.js';
import type { TaskEnvelopeStore } from '../events/task-envelope.js';

/**
 * Spec C10 ExecutionContext — the typed shared state for a per-task run.
 * Populated by `prepare_execution_context` (row 2.5) and read by every
 * downstream handler.
 *
 * Inputs (Group A) are read-only after row 2.5 completes.
 * Bus + heartbeat (Group B) carry mutable runtime state for the watchdog.
 * Cost (Group C) is tracked via stateless priceTokens() / rollupByTier() in bounded-execution; not held on ExecutionContext.
 *
 * Per-chain accumulators (Group D) live on `LifecycleState` itself, not
 * here, because each chain handler mutates them as it fires; ExecutionContext
 * is for stable per-task wiring.
 */
export interface ExecutionContext {
  // ── Group A: Inputs ──
  task: TaskSpec;
  taskIndex: number;
  config: MultiModelConfig;
  cwd: string;
  route: string;
  client: string;
  mainModel: string | null;

  /** Tier the dispatcher assigned to this task. Stays fixed; rotation lives in per-round handlers via pickReviewer/pickEscalation. */
  assignedTier: AgentType;
  implementerProvider: Provider;
  /** Other-tier provider for fallback / reviewer separation. May be undefined when only one tier is configured. */
  escalationProvider: Provider | undefined;
  /** Map of available tier → provider. Built from {assignedTier, escalationProvider}. */
  providers: Partial<Record<AgentType, Provider>>;
  implementerIdentity: CanonicalIdentity | undefined;

  /**
   * v4.4 session source-of-truth. Each call returns the (lazy-created)
   * Session for the given tier — the SAME instance across stages within
   * one task, so codex CLI's `codex exec resume` and claude-agent-sdk's
   * `resume: sessionId` both reload the prior conversation. Throws if
   * the tier has no configured provider.
   *
   * Cleanup: `closeSessions()` is invoked by task-runner.ts's finally
   * block; handlers MUST NOT call session.close() themselves.
   */
  getSession(tier: AgentType): Session;
  closeSessions(): Promise<void>;
  /** Returns OS pids of every currently-open session's CLI subprocess (if any).
   *  Used by shutdown drain to SIGKILL stragglers when closeSessions() exceeds
   *  its grace window. Empty array when no sessions are open OR the providers
   *  do not spawn subprocesses (e.g. in-process SDK clients). */
  getActivePids(): number[];

  // ── Per-task budgets ──
  timing: {
    startMs: number;
    timeoutMs: number;
    deadlineMs: number;
    stallTimeoutMs: number;
  };

  /** Wall-clock budget guard. Throws GuardError once budgetMs since task start
   *  is exceeded. Stage entries + tool-call boundaries call checkOrThrow(). */
  wallClockGuard: WallClockGuard;

  // ── Stall watchdog ──
  stall: {
    controller: AbortController;
    /** ms timestamp of the most recent runner event; updated by markRunnerEvent. */
    lastEventAtMs: number;
    /** Set true when stall fires; prevents duplicate aborts. */
    fired: boolean;
  };

  // ── Implementer policy ──
  implementerToolMode: TaskSpec['tools'];

  /** Per-task review prompt builder — quality reviewer route customizes this. Optional. */
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string;

  // ── Group B: Bus + heartbeat ──
  bus: EnvelopeBus | undefined;
  heartbeat: ActivityTracker | undefined;
  /** Logger sink — Step 6 (terminal handlers) will use this for final flush.
   *  Minimal structural shape; the full HttpServerLog interface was removed in the
   *  events unification refactor. Only `error(kind, err)` is consumed by callers. */
  logger?: { error: (kind: string, err: unknown) => void };

  /** Per-task event envelope for recording lifecycle mutations. */
  envelope: TaskEnvelopeStore;

  /**
   * Heartbeat tick recorder — server-supplied callback that turns
   * HeartbeatTickInfo into BatchRegistry.updateRunningHeadlineSnapshot.
   * Optional (CLI/local clients don't have a BatchRegistry).
   */
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;

  /**
   * Number of repo-groups the current batch was split into by
   * groupTasksByRepo. Set by task-executor immediately after grouping,
   * BEFORE any dispatchOne fires. Consumed by task-runner.ts to gate
   * PARALLEL_SAFETY_SUFFIX (suffix is only appended when this value > 1,
   * because within a single group tasks run serially and full builds are
   * safe).
   */
  batchGroupCount?: number;

  /**
   * Server-supplied callback that records the per-batch grouping snapshot
   * onto the BatchRegistry entry. Optional (CLI/local clients don't have
   * a BatchRegistry — same pattern as recordHeartbeat). Called once per
   * batch by task-executor immediately after groupTasksByRepo resolves.
   */
  attachBatchGroups?: (groups: Array<{ key: string; taskIndices: number[] }>) => void;

  /**
   * Server-supplied callback that records grouping telemetry to be
   * attached to the eventual batch_completed event. Optional — same
   * pattern as recordHeartbeat / attachBatchGroups. Called once per
   * batch by task-executor immediately after grouping resolves.
   */
  setBatchGroupingTelemetry?: (info: {
    groupCount: number;
    groupSizes: number[];
    serializationApplied: boolean;
  }) => void;

  /** Telemetry recorder — server-only, used at terminal to record task.completed. */
  recorder?: {
    recordTaskCompleted: (params: {
      route: string;
      taskSpec: TaskSpec;
      runResult: import('../types.js').RuntimeRunResult;
      realFilesChanged: string[];
      client: string;
      mainModel: string | null;
      reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none';
      verifyCommandPresent?: boolean;
    }) => void;
  };

  // ── Output target tracking ──
  outputTargets: string[];

  
  // ── Pre-v4 executor compatibility (Phase B/E will consume these) ──
  /** Per-project runtime state — used by executor-layer consumers (delegate, etc.). */
  projectContext?: ProjectContext;
  /** Context block store — used by executor-layer consumers for intake expansion. */
  contextBlockStore?: ContextBlockStore;
  /** BatchId owning this execution — threaded so ActivityTracker can tag ticks. */
  batchId?: string;
  /** Optional BatchRegistry — when set, task-runner attaches this ctx onto
   *  the entry so shutdown drain can close sessions across all in-flight
   *  tasks. Server callers pass this through HandlerDeps; CLI callers omit. */
  batchRegistry?: import('../stores/batch-registry.js').BatchRegistry;
}
