// packages/core/src/executors/types.ts
import type { ProjectContext } from '../project-context.js';
import type { MultiModelConfig, RunResult, BatchTimings, BatchAggregateCost } from '../types.js';
import type { DiagnosticLogger } from '../diagnostics/disconnect-log.js';
import type { ContextBlockStore } from '../context/context-block-store.js';

export interface ExecutionContext {
  projectContext: ProjectContext;
  config: MultiModelConfig;
  logger: DiagnosticLogger;
  contextBlockStore: ContextBlockStore;
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
