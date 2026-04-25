// packages/server/src/http/execution-context.ts
import { composeRunningHeadline } from '@zhixuan92/multi-model-agent-core';
import type { ProjectContext, HeartbeatTickInfo } from '@zhixuan92/multi-model-agent-core';
import { buildExecutionContext as buildCoreExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/execution-context';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/types';
import type { HandlerDeps } from './handler-deps.js';

/**
 * Builds the ExecutionContext passed to every executor.
 *
 * The server adapter owns HTTP-specific heartbeat wiring, then delegates
 * required-field validation and context object construction to the core
 * `buildExecutionContext` factory.
 */
export function buildExecutionContext(
  deps: HandlerDeps,
  pc: ProjectContext,
  batchId: string,
): ExecutionContext {
  const recordHeartbeat = (tick: HeartbeatTickInfo) => {
    const effectiveBatchId = tick.batchId || batchId;
    const entry = deps.batchRegistry.get(effectiveBatchId);
    if (!entry) return;
    entry.lastHeartbeatAt = Date.now();
    // Tag the active worker so composeRunningHeadline can render
    // "running, 47s elapsed, worker: MiniMax-M2.7 (turn 2)" instead of
    // just "1/1 running". stageIndex is a reasonable turn proxy.
    entry.running = [{ worker: tick.provider, turn: Math.max(1, tick.stageIndex) }];
    // Single-task batches get the rich per-stage headline composed by
    // HeartbeatTimer (stage name, cost/ROI, file counts, tool calls).
    // Multi-task batches fall back to the batch-level summary since no
    // single worker's headline applies across tasks.
    const tasksTotal = entry.tasksTotal ?? 1;
    const headline = tasksTotal <= 1
      ? tick.headline
      : composeRunningHeadline({
          tasksTotal,
          tasksStarted: entry.tasksStarted ?? 0,
          tasksCompleted: entry.tasksCompleted ?? 0,
          startedAt: entry.startedAt,
          nowMs: Date.now(),
          lastHeartbeatAt: entry.lastHeartbeatAt,
          running: entry.running,
        });
    deps.batchRegistry.updateRunningHeadline(effectiveBatchId, headline);
  };

  return buildCoreExecutionContext({
    projectContext: pc,
    config: deps.config,
    logger: deps.logger,
    contextBlockStore: pc.contextBlocks,
    parentModel: process.env['PARENT_MODEL_NAME'],
    batchId,
    recordHeartbeat,
  });
}
