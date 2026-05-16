// packages/server/src/http/execution-context.ts
import type { HeartbeatTickInfo } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionContext } from '@zhixuan92/multi-model-agent-core';
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
      deps.batchRegistry.updateRunningHeadlineSnapshot(effectiveBatchId, tick.snapshot);
    }
  };

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
    task: { prompt: '' },
    taskIndex: 0,
    cwd: pc.cwd,
    assignedTier: 'standard',
    implementerProvider: undefined,
    escalationProvider: undefined,
    providers: {},
    implementerIdentity: undefined,
    timing: { startMs: now, timeoutMs: 0, deadlineMs: 0, stallTimeoutMs: 0 },
    budgets: { maxCostUSD: undefined },
    stall: { controller: new AbortController(), lastEventAtMs: now, fired: false },
    implementerToolMode: undefined,
    heartbeat: undefined,
    // Verbose is compulsory (4.6.0+). Always wire the stderr stream so the
    // runner-shell + adapter emit per-turn events to the daemon's stderr.
    verboseStream: (line: string) => { process.stderr.write(line); },
    verbose: true,
    outputTargets: [],
  } as unknown as ExecutionContext;
}
