import { randomUUID } from 'node:crypto';
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { RunResult } from '../../types.js';

/**
 * Terminal-stage handlers (#45 Step 6).
 *
 * Four StagePlan rows:
 *   - 5.3.5 register_terminal_block — registers a context block carrying
 *     the terminal RunResult so /retry can reference the prior task's
 *     output. Today owned by reviewed-lifecycle's __recordOnce path.
 *   - 5.4   emit_task_terminal     — emits the per-task terminal event
 *     (task_done_summary) through ctx.bus.
 *   - 5.5   persist_to_batch_registry — marks the per-task state in the
 *     batch registry. Today owned by async-dispatch.
 *   - 6.1   flush_telemetry — drains the telemetry queue so failure
 *     events are persisted before the per-task terminal stage exits.
 *
 * Each handler is idempotent on its state-slot guard:
 *   - state.terminalBlockId
 *   - state.taskTerminalEmitted
 *   - state.batchRegistryPersisted
 *   - state.telemetryFlushed
 *
 * Defensive no-ops on missing state.executionContext or
 * state.lastRunResult. All four rows are marked runOnTerminal in the
 * StagePlan, so they fire even on hard-fail paths.
 */

interface TerminalContextBlockStore {
  register?(payload: { id: string; content: string }): void;
}

export function registerTerminalBlockHandler(state: LifecycleState): void {
  if (state.terminalBlockId) return;
  const ctx = state.executionContext as
    | (ExecutionContext & { contextBlockStore?: TerminalContextBlockStore })
    | undefined;
  if (!ctx) return;
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return;

  const id = `terminal-${randomUUID()}`;
  state.terminalBlockId = id;

  const store = ctx.contextBlockStore;
  if (store && typeof store.register === 'function') {
    try {
      store.register({ id, content: last.output ?? '' });
    } catch {
      // Best-effort: terminal-block registration is advisory; failure must
      // not block emit_task_terminal or batch-registry persistence.
    }
  }
}

export function emitTaskTerminalHandler(state: LifecycleState): void {
  if (state.taskTerminalEmitted) return;
  const ctx = state.executionContext;
  if (!ctx) return;
  const bus = ctx.bus;
  if (!bus) {
    state.taskTerminalEmitted = true; // mark even when bus absent so re-runs are noops
    return;
  }
  const last = state.lastRunResult as RunResult | undefined;
  bus.emit({
    event: 'task_done_summary',
    ts: new Date().toISOString(),
    route: state.route,
    workerStatus: last?.workerStatus,
    terminalBlockId: state.terminalBlockId,
    specChainPassed: state.specChainPassed,
    qualityChainPassed: state.qualityChainPassed,
    diffReviewVerdict: state.diffReviewVerdict,
  } as Record<string, unknown>);
  state.taskTerminalEmitted = true;
}

interface BatchRegistryLike {
  complete?(taskIndex: number, result: unknown): void;
}

export function persistToBatchRegistryHandler(state: LifecycleState): void {
  if (state.batchRegistryPersisted) return;
  const ctx = state.executionContext as
    | (ExecutionContext & { batchRegistry?: BatchRegistryLike })
    | undefined;
  if (!ctx) return;
  const registry = ctx.batchRegistry;
  if (!registry || typeof registry.complete !== 'function') {
    state.batchRegistryPersisted = true; // structural ack
    return;
  }
  try {
    registry.complete(ctx.taskIndex, state.lastRunResult);
  } catch {
    // Persistence failure is non-fatal at the per-task boundary; retention
    // sweep (row 6.3) reconciles via timer.
  }
  state.batchRegistryPersisted = true;
}

interface RecorderLike {
  flush?(): Promise<void> | void;
}

export async function flushTelemetryHandler(state: LifecycleState): Promise<void> {
  if (state.telemetryFlushed) return;
  const ctx = state.executionContext as
    | (ExecutionContext & { recorder?: RecorderLike })
    | undefined;
  if (!ctx) return;
  const recorder = ctx.recorder;
  if (!recorder || typeof recorder.flush !== 'function') {
    state.telemetryFlushed = true;
    return;
  }
  try {
    await recorder.flush();
  } catch {
    // Telemetry flush is best-effort; the recorder retains in-memory queue
    // for the next opportunity.
  }
  state.telemetryFlushed = true;
}
