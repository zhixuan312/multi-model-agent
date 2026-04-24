// packages/core/src/executors/types.ts
import type { ProjectContext } from '../project-context.js';
import type { Provider, RunResult, BatchTimings, BatchAggregateCost, MultiModelConfig } from '../types.js';
import type { DiagnosticLogger } from '../diagnostics/disconnect-log.js';
import type { ContextBlockStore } from '../context/context-block-store.js';

// Plan-specified auxiliary types (Task 1.9)

export interface ClarificationProposal {
  kind: string;
  interpretation: string;
  details?: Record<string, unknown>;
}

export type ClarificationResponse = {
  interpretation: string;
};

export interface ProgressEvent {
  kind: string;
  message: string;
  timestamp: number;
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
  /**
   * Resolves a named agent profile (e.g. "standard", "complex") to a Provider instance.
   *
   * NOTE: interface-populated but not currently consumed by any executor. Today executors pass
   * `ctx.config` to `runTasks()`, which resolves providers internally via `createProvider`.
   * Declared here because the 3.0.0 plan mandates this channel; retained so future per-request
   * provider overrides (tenant auth, per-request model swap) can flow through the context.
   */
  providerFactory: (profile: string) => Provider;
  /** Optional progress callback for streaming progress events to callers. */
  onProgress?: (event: ProgressEvent) => void;
  /** Awaits a clarification response from the caller. Not supported in MCP context (stub rejects). */
  awaitClarification: (proposal: ClarificationProposal) => Promise<ClarificationResponse>;
  /** The parent model name, resolved from env at context-build time. */
  parentModel?: string;
}

/**
 * Uniform output envelope returned by every executor.
 * Required shape for GET /batch/:id?taskIndex=N slicing (see spec §6.5).
 *
 * All four top-level fields are required; additional passthrough fields
 * (batchId, contextBlockId, clarificationId, etc.) are preserved.
 */
export interface ExecutorOutput {
  results: RunResult[];
  headline: string;
  batchTimings: BatchTimings;
  costSummary: BatchAggregateCost;
  batchId: string;
  contextBlockId?: string;
  clarificationId?: string;
  wallClockMs?: number;
  parentModel?: string;
}
