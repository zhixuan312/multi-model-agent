// packages/core/src/executors/types.ts
import type { ProjectContext } from '../project-context.js';
import type { RunResult, MultiModelConfig } from '../types.js';
import type { DiagnosticLogger } from '../diagnostics/disconnect-log.js';
import type { ContextBlockStore } from '../context/context-block-store.js';
import type { NotApplicable } from '../reporting/not-applicable.js';
import type { HeartbeatTickInfo } from '../heartbeat.js';

/** Aggregate timing metrics for a `delegate_tasks` batch. */
export interface BatchTimings {
  wallClockMs: number
  sumOfTaskMs: number
  estimatedParallelSavingsMs: number
}

/** Aggregate completion counts for a `delegate_tasks` batch. */
export interface BatchProgress {
  totalTasks: number
  completedTasks: number
  incompleteTasks: number
  failedTasks: number
  successPercent: number;
}

/** Aggregate cost metrics for a `delegate_tasks` batch. */
export interface BatchAggregateCost {
  totalActualCostUSD: number
  totalSavedCostUSD: number
}

export interface ExecutionContext {
  projectContext: ProjectContext;
  config: MultiModelConfig;
  /**
   * Diagnostic logger for the request scope.
   *
   * NOTE: interface-populated but not currently consumed by any executor. Diagnostic events
   * today emit from the HTTP pipeline and `run-tasks.ts` runner layer. Retained so future
   * executor-internal events (e.g. mid-flight aborts, partial-progress signals) can flow
   * through the same scoped logger.
   */
  logger: DiagnosticLogger;
  contextBlockStore: ContextBlockStore;
  /** The parent model name, resolved from env at context-build time. */
  parentModel?: string;
  /** BatchId owning this execution — threaded to runTasks so HeartbeatTimer can tag ticks. */
  batchId?: string;
  /** Callback invoked on every heartbeat tick; pushes a running headline to the caller's store. */
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  /** Telemetry recorder — fire-and-forget, failures are silently dropped. */
  recorder?: {
    recordTaskCompleted: (ctx: {
      route: string;
      taskSpec: { filePaths?: string[] };
      runResult: RunResult;
      client: string;
      triggeringSkill: string;
      parentModel: string | null;
    }) => void;
  };
  /** Route name for telemetry (e.g. 'delegate', 'audit'). */
  route?: string;
  /** Client identifier for telemetry (e.g. 'claude-code', 'cursor'). */
  client?: string;
  /** Triggering skill for telemetry (e.g. 'mma-delegate', 'direct'). */
  triggeringSkill?: string;
}

export interface ExecutionContextInput {
  projectContext: ProjectContext;
  config: MultiModelConfig;
  logger: DiagnosticLogger;
  contextBlockStore: ContextBlockStore;
  parentModel?: string;
  batchId?: string;
  recordHeartbeat?: (tick: HeartbeatTickInfo) => void;
  /** Telemetry recorder — fire-and-forget, failures are silently dropped. */
  recorder?: {
    recordTaskCompleted: (ctx: {
      route: string;
      taskSpec: { filePaths?: string[] };
      runResult: RunResult;
      client: string;
      triggeringSkill: string;
      parentModel: string | null;
    }) => void;
  };
  route?: string;
  client?: string;
  triggeringSkill?: string;
}

/**
 * Uniform output envelope returned by every executor.
 * Required shape for GET /batch/:id?taskIndex=N slicing (see spec §6.5).
 *
 * All 7 top-level envelope fields are required. Fields that are not
 * applicable for a given executor or code path are set to NotApplicable
 * via `notApplicable(reason)` rather than being omitted. Additional
 * passthrough fields (batchId, contextBlockId, clarificationId, etc.)
 * are preserved alongside the envelope.
 */
export interface ExecutorOutput {
  headline: string;
  results: RunResult[] | NotApplicable;
  batchTimings: BatchTimings | NotApplicable;
  costSummary: BatchAggregateCost | NotApplicable;
  structuredReport: Record<string, unknown> | NotApplicable;
  error: { code: string; message: string; details?: unknown } | NotApplicable;
  proposedInterpretation: string | NotApplicable;
  batchId: string;
  contextBlockId?: string;
  clarificationId?: string;
  wallClockMs?: number;
  parentModel?: string;
}
