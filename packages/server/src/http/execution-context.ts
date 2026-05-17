// packages/server/src/http/execution-context.ts
import type { HeartbeatTickInfo } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
import type { TaskEnvelopeStore } from '@zhixuan92/multi-model-agent-core/events/task-envelope';
import type { HandlerDeps } from './handler-deps.js';
import type { ProjectContext } from '@zhixuan92/multi-model-agent-core';
import { getRecorder } from '../telemetry/recorder.js';

/**
 * Builds a canonical ExecutionContext for the async-dispatch → executor path.
 *
 * The canonical type carries lifecycle-specific required fields (task, timing,
 * stall, etc.) that aren't applicable in the server→executor code path. We
 * cast through `as ExecutionContext` because the executors only access the
 * subset of fields populated here. Phase B/E will migrate executors into the
 * full lifecycle, after which this shim can be deleted.
 */
export function buildExecutionContext(
  deps: HandlerDeps,
  pc: ProjectContext,
  batchId: string,
  envelope: TaskEnvelopeStore,
  route?: string,
  caller?: { client: string; mainModel?: string | null },
): ExecutionContext {
  const recordHeartbeat = (tick: HeartbeatTickInfo) => {
    const effectiveBatchId = tick.batchId || batchId;
    const entry = deps.batchRegistry.get(effectiveBatchId);
    if (!entry) return;
    entry.lastHeartbeatAt = Date.now();
    entry.running = [{ worker: tick.provider, turn: Math.max(1, tick.stageIndex) }];
    if (tick.snapshot) {
      // Legacy single-snapshot field — kept for back-compat with any reader
      // that hasn't migrated to the per-task field.
      deps.batchRegistry.updateRunningHeadlineSnapshot(effectiveBatchId, tick.snapshot);
      // Per-task snapshot — the polling handler's preferred branch
      // (batch.ts:67-126). Populates structured fields so the polling 202
      // body reflects current stage + counts instead of the seed value.
      // Task index 0: async-dispatch seeded taskIndex=0; multi-task
      // executors that fan out additional tasks supply their own real
      // taskIndex via the runner's bus events, and that ladder is handled
      // by the dispatcher-level seed. For single-task batches taskIndex
      // defaults to 0 — matches the async-dispatch seed at line 104.
      deps.batchRegistry.updatePerTaskHeadlineSnapshot(effectiveBatchId, 0, {
        prefix: tick.snapshot.prefix,
        statsClause: tick.snapshot.statsClause,
        dispatchedAt: tick.snapshot.dispatchedAt,
        fallback: tick.snapshot.fallback,
        stageLabel: capitalizeStage(tick.stage),
        stageDone: tick.stageIndex,
        stageTotal: tick.stageCount,
        toolReads: tick.progress.filesRead,
        toolWrites: tick.progress.filesWritten,
        toolTotal: tick.progress.toolCalls,
      });
    }
  };

  function capitalizeStage(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const attachBatchGroups: ExecutionContext['attachBatchGroups'] = (groups) => {
    deps.batchRegistry.attachGroups(batchId, groups);
  };

  const setBatchGroupingTelemetry: ExecutionContext['setBatchGroupingTelemetry'] = (info) => {
    deps.batchRegistry.setGroupingTelemetry(batchId, info);
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
    logger: deps.logger,
    bus: deps.bus,
    // Per-request X-MMA-Main-Model header is the only source. Enforced at
    // the request-pipeline boundary (4.0.3+); by the time we reach this
    // builder, caller.mainModel is guaranteed non-null for tool routes.
    mainModel: caller?.mainModel ?? null,
    route: route ?? '',
    client: caller?.client ?? 'other',
    batchId,
    recordHeartbeat,
    attachBatchGroups,
    setBatchGroupingTelemetry,
    recorder,
    projectContext: pc,
    contextBlockStore: pc.contextBlocks,
    // Thread the BatchRegistry so task-runner can attach this ctx for
    // shutdown-drain visibility into in-flight tasks.
    batchRegistry: deps.batchRegistry,
    task: { prompt: '' },
    taskIndex: 0,
    cwd: pc.cwd,
    assignedTier: 'standard',
    implementerProvider: undefined,
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: now, timeoutMs: 0, deadlineMs: 0, stallTimeoutMs: 0 },
    stall: { controller: new AbortController(), lastEventAtMs: now, fired: false },
    implementerToolMode: undefined,
    heartbeat: undefined,
    // Verbose is compulsory (4.6.0+). Always wire the stderr stream so the
    // runner-shell + adapter emit per-turn events to the daemon's stderr.
    verboseStream: (line: string) => { process.stderr.write(line); },
    verbose: true,
    outputTargets: [],
    envelope,
  } as unknown as ExecutionContext;
}
