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
  logger: DiagnosticLogger;
  contextBlockStore: ContextBlockStore;
  /** Resolves a named agent profile (e.g. "standard", "complex") to a Provider instance. */
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
