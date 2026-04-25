// packages/server/src/http/execution-context.ts
import { composeRunningHeadline } from '@zhixuan92/multi-model-agent-core';
import type { ProjectContext, HeartbeatTickInfo } from '@zhixuan92/multi-model-agent-core';
import { buildExecutionContext as buildCoreExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/execution-context';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core/executors/types';
import type { HandlerDeps } from './handler-deps.js';
import { getRecorder } from '../telemetry/recorder.js';

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
  route?: string,
): ExecutionContext {
  const recordHeartbeat = (tick: HeartbeatTickInfo) => {
    const effectiveBatchId = tick.batchId || batchId;
    const entry = deps.batchRegistry.get(effectiveBatchId);
    if (!entry) return;
    entry.lastHeartbeatAt = Date.now();
    entry.running = [{ worker: tick.provider, turn: Math.max(1, tick.stageIndex) }];
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

  let recorder: ExecutionContext['recorder'] | undefined;
  try {
    // Server's Recorder uses a stricter route enum than ExecutionContext['recorder']
    // (which takes a plain string). The server type is a strict subset of what core
    // accepts at runtime, so cast through unknown to satisfy TS function-parameter
    // contravariance — fire-and-forget telemetry never reads the route field anyway.
    recorder = getRecorder() as unknown as ExecutionContext['recorder'];
  } catch {
    // Recorder not initialized — telemetry disabled
  }

  return buildCoreExecutionContext({
    projectContext: pc,
    config: deps.config,
    logger: deps.logger,
    contextBlockStore: pc.contextBlocks,
    parentModel: process.env['PARENT_MODEL_NAME'],
    batchId,
    recordHeartbeat,
    recorder,
    route,
  });
}
