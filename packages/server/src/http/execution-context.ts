// packages/server/src/http/execution-context.ts
import type { HeartbeatTickInfo } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelopeStore } from '@zhixuan92/multi-model-agent-core/events/task-envelope';
import type { HandlerDeps } from './handler-deps.js';
import type { ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { getRecorder } from '../telemetry/recorder.js';

/**
 * Builds a canonical ExecutionContext for the task dispatch -> executor path.
 *
 * The canonical type carries lifecycle-specific required fields (task, timing,
 * stall, etc.) that aren't applicable in the server->executor code path. We
 * cast through `as ExecutionContext` because the executors only access the
 * subset of fields populated here. Phase B/E will migrate executors into the
 * full lifecycle, after which this shim can be deleted.
 */
export function buildExecutionContext(
  deps: HandlerDeps,
  pc: ProjectContext,
  taskId: string,
  envelope: TaskEnvelopeStore,
  route?: string,
  caller?: { client: string; mainModel?: string | null },
): ExecutionContext {
  const recordHeartbeat = (_tick: HeartbeatTickInfo) => {
    // TaskRegistry does not track heartbeat state; headline updates
    // are handled via taskRegistry.setHeadline() at a higher level.
    // Record heartbeat to envelope — this triggers snapshot push with recomputed headline
    envelope.recordHeartbeat({ stallIdleMs: 0 });
  };

  let recorder: ExecutionContext['recorder'] | undefined;
  try {
    recorder = getRecorder() as unknown as ExecutionContext['recorder'];
  } catch {
    // Recorder not initialized — telemetry disabled
  }

  const now = Date.now();

  return {
    config: deps.config,
    bus: deps.bus,
    // Per-request X-MMA-Main-Model header is the only source. Enforced at
    // the request-pipeline boundary (4.0.3+); by the time we reach this
    // builder, caller.mainModel is guaranteed non-null for tool routes.
    mainModel: caller?.mainModel ?? null,
    route: route ?? '',
    client: caller?.client ?? 'other',
    batchId: taskId,
    recordHeartbeat,
    recorder,
    projectContext: pc,
    contextBlockStore: pc.contextBlocks,
    task: { prompt: '' },
    taskIndex: 0,
    cwd: pc.cwd,
    assignedTier: 'standard',
    implementerProvider: undefined,
    providers: {},
    timing: { startMs: now, timeoutMs: 0, deadlineMs: 0, stallTimeoutMs: 0 },
    stall: { controller: new AbortController(), lastEventAtMs: now, fired: false },
    implementerToolMode: undefined,
    heartbeat: undefined,
    outputTargets: [],
    envelope,
  } as unknown as ExecutionContext;
}
