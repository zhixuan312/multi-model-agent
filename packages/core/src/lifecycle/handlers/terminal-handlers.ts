import { randomUUID } from 'node:crypto';
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { RuntimeRunResult, TaskSpec } from '../../types.js';
import type { StageGate, TerminalPayload } from '../stage-io.js';
import { findModelProfile } from '../../config/model-profile-registry.js';
import { getRealFilesChanged } from '../real-diff.js';

/**
 * Terminal-stage handlers (#45 Step 6).
 *
 * Four StagePlan rows:
 *   - 5.3.5 register_terminal_block — registers a context block carrying
 *     the terminal RuntimeRunResult so /retry can reference the prior task's
 *     output.
 *   - 5.4   emit_task_terminal     — emits the per-task terminal event
 *     (task_done_summary) through ctx.bus.
 *   - 5.5   persist_to_batch_registry — marks the per-task state in the
 *     batch registry.
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
  const last = state.lastRunResult as RuntimeRunResult | undefined;
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
  const last = state.lastRunResult as RuntimeRunResult | undefined;

  // Sum tokens / counts across every recorded stage so the local task_completed
  // event carries the FULL cost (implementer + reviewer + annotator + rework
  // + diff). Previously this read last.usage directly which only carried the
  // implementer tokens — reviewer / annotator costs were dropped.
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedReadTokens = 0;
  let cachedNonReadTokens = 0;
  let toolCallsTotal = 0;
  let turnsTotal = 0;
  let filesReadTotal = 0;
  let filesWrittenTotal = 0;
  const ss = (last as { stageStats?: Record<string, Record<string, unknown>> } | undefined)?.stageStats;

  // A11.2: compute actualCostUSD as the sum of every stage's costUSD.
  // costUSD and totalCostUSD are back-compat aliases for the same value.
  // costDeltaVsMainUSD comes from the top-level cost field on RuntimeRunResult.
  let actualCostUSD: number | null = null;
  let costDeltaVsMainUSD: number | null = null;

  if (ss) {
    for (const stage of Object.values(ss)) {
      if (!stage || !(stage['entered'] as boolean | undefined)) continue;
      inputTokens += (stage['inputTokens'] as number | null | undefined) ?? 0;
      outputTokens += (stage['outputTokens'] as number | null | undefined) ?? 0;
      cachedReadTokens += (stage['cachedReadTokens'] as number | null | undefined) ?? 0;
      cachedNonReadTokens += (stage['cachedNonReadTokens'] as number | null | undefined) ?? 0;
      toolCallsTotal += (stage['toolCallCount'] as number | null | undefined) ?? 0;
      turnsTotal += (stage['turnCount'] as number | null | undefined) ?? 0;
      filesReadTotal += (stage['filesReadCount'] as number | null | undefined) ?? 0;
      filesWrittenTotal += (stage['filesWrittenCount'] as number | null | undefined) ?? 0;
      const stageCost = stage['costUSD'] as number | null | undefined;
      if (stageCost !== null && stageCost !== undefined) {
        actualCostUSD = (actualCostUSD ?? 0) + stageCost;
      }
    }
    costDeltaVsMainUSD = (last as { cost?: { costDeltaVsMainUSD?: number | null } })?.cost?.costDeltaVsMainUSD ?? null;
  }
  // Fallback to last.usage when stageStats wasn't populated (legacy paths).
  if (inputTokens === 0 && outputTokens === 0 && last?.usage) {
    inputTokens = last.usage.inputTokens ?? 0;
    outputTokens = last.usage.outputTokens ?? 0;
    cachedReadTokens = last.usage.cachedReadTokens ?? 0;
    cachedNonReadTokens = last.usage.cachedNonReadTokens ?? 0;
  }
  if (turnsTotal === 0) turnsTotal = last?.turns ?? 0;
  if (toolCallsTotal === 0) toolCallsTotal = Array.isArray(last?.toolCalls) ? last!.toolCalls.length : 0;
  if (filesReadTotal === 0) filesReadTotal = Array.isArray(last?.filesRead) ? last!.filesRead.length : 0;
  if (filesWrittenTotal === 0) filesWrittenTotal = Array.isArray(last?.filesWritten) ? last!.filesWritten.length : 0;

  // Emit a per-stage map so consumers see the breakdown without unpacking
  // RuntimeRunResult. Each entry: stage -> { inputTokens, outputTokens, costUSD,
  // turnCount, toolCallCount, durationMs, tier, model, verdict? }.
  const stagesMap: Record<string, Record<string, unknown>> = {};
  if (ss) {
    for (const [name, stage] of Object.entries(ss)) {
      if (!stage || !(stage['entered'] as boolean | undefined)) continue;
      stagesMap[name] = {
        inputTokens: stage['inputTokens'] ?? 0,
        outputTokens: stage['outputTokens'] ?? 0,
        cachedReadTokens: stage['cachedReadTokens'] ?? 0,
        cachedNonReadTokens: stage['cachedNonReadTokens'] ?? 0,
        costUSD: stage['costUSD'] ?? null,
        turnCount: stage['turnCount'] ?? 0,
        toolCallCount: stage['toolCallCount'] ?? 0,
        durationMs: stage['durationMs'] ?? null,
        agentTier: stage['agentTier'] ?? null,
        model: stage['model'] ?? null,
        ...(stage['verdict'] !== undefined && { verdict: stage['verdict'] }),
        ...(stage['roundsUsed'] !== undefined && { roundsUsed: stage['roundsUsed'] }),
      };
    }
  }
  const stages = JSON.stringify(stagesMap);

  bus.emit({
    event: 'task_completed',
    ts: new Date().toISOString(),
    batchId: ctx.batchId,
    taskIndex: ctx.taskIndex,
    route: state.route,
    status: last?.status ?? 'error',
    workerStatus: last?.workerStatus ?? null,
    turns: turnsTotal,
    durationMs: last?.durationMs ?? null,
    filesRead: filesReadTotal,
    filesWritten: filesWrittenTotal,
    toolCalls: toolCallsTotal,
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedNonReadTokens,
    // A11.2 — populate the full cost surface on the task_completed envelope.
    // actualCostUSD is the new canonical field (sum of every stage's costUSD).
    // costUSD and totalCostUSD are back-compat aliases — emit all three so
    // existing callers and new callers both get the value they expect.
    // costDeltaVsMainUSD: delta vs estimated main-tier cost (from CostBreakdown).
    actualCostUSD,
    costUSD: actualCostUSD,
    totalCostUSD: actualCostUSD,
    costDeltaVsMainUSD,
    taskMaxIdleMs: null,
    stallTriggered: false,
    stages,
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

/**
 * Row 5.6 — record_task_completed.
 *
 * Builds the cloud `task.completed` wire event and hands it to the server
 * recorder. Idempotent on state.taskCompletedRecorded. No-op when the
 * server hasn't supplied a recorder (CLI/test paths).
 */
export async function recordTaskCompletedHandler(state: LifecycleState): Promise<void> {
  if (state.taskCompletedRecorded) return;
  const ctx = state.executionContext;
  if (!ctx) return;
  const recorder = ctx.recorder;
  if (!recorder || typeof recorder.recordTaskCompleted !== 'function') {
    state.taskCompletedRecorded = true;
    return;
  }
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RuntimeRunResult | undefined;
  if (!task || !last) {
    state.taskCompletedRecorded = true;
    return;
  }
  ensureImplementingStage(last, ctx);
  const realFiles = await getRealFilesChanged(state);
  try {
    // Gap 15 fix (4.0.3+): thread the per-task reviewPolicy into the
    // wire BuildContext so the wire row reflects what the lifecycle
    // actually ran. Pre-fix the BuildContext fell back to the route
    // default ('full' for delegate, 'quality_only' for read-only),
    // overriding per-task TaskSpec.reviewPolicy that the lifecycle
    // had already honored at the row level. Now: per-task wins; the
    // route default applies only when the task didn't specify.
    recorder.recordTaskCompleted({
      route: ctx.route as Parameters<typeof recorder.recordTaskCompleted>[0]['route'],
      taskSpec: task,
      runResult: last,
      realFilesChanged: realFiles.files,   // NEW — wire the computed list
      client: ctx.client ?? '',
      mainModel: ctx.mainModel ?? null,
      // v5: thread state.gates so the wire builder can read each stage's
      // canonical telemetry (durationMs / costUSD / turnsUsed) from the gate
      // instead of relying solely on the legacy mergeStageStats mirror.
      ...(state.gates && { gates: state.gates }),
      ...(task.reviewPolicy !== undefined && { reviewPolicy: task.reviewPolicy }),
    });
  } catch {
    // recorder is best-effort — never break terminal flow on telemetry.
  }
  state.taskCompletedRecorded = true;
}

/**
 * Synthesize an `implementing` stage entry from top-level RuntimeRunResult fields
 * when the per-stage tracker hasn't populated it. Without this, the wire
 * event ships with `stages: []` for every task, which violates the backend's
 * R2.1 invariant ("empty stages only allowed for brief_too_vague|error")
 * for any task that succeeded — every upload would 400.
 *
 * This is a fallback; it does not replace stats already populated by the
 * runner-shell or lifecycle stage tracker.
 */
function ensureImplementingStage(
  rr: RuntimeRunResult,
  ctx: {
    assignedTier?: 'standard' | 'complex';
    implementerProvider?: { config?: { model?: string } };
  },
): void {
  // Even when no LLM call ever fires (runner_crash, all_tiers_unavailable,
  // dispatcher-no-result), the configured implementer model is known up
  // front via ctx.implementerProvider.config. Stamp it into the synthesized
  // stage and the top-level rr.models so the wire row reports the *intended*
  // model instead of the literal 'custom' fallback in event-builder.
  const fallbackModel =
    (ctx.implementerProvider?.config as { model?: string } | undefined)?.model ?? null;
  const fallbackFamily = fallbackModel ? findModelProfile(fallbackModel).family : null;

  if (rr.models === undefined && fallbackModel !== null) {
    (rr as { models?: RuntimeRunResult['models'] }).models = {
      implementer: fallbackModel,
      specReviewer: undefined,
      qualityReviewer: undefined,
    };
  }

  const existing = (rr.stageStats?.implementing) as { entered?: boolean } | undefined;
  if (existing?.entered) return;
  const usage = rr.usage ?? { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 };
  const synthesized = {
    stage: 'implementing' as const,
    entered: true,
    durationMs: rr.durationMs ?? 0,
    costUSD: rr.cost?.costUSD ?? null,
    agentTier: ctx.assignedTier ?? 'standard',
    modelFamily: fallbackFamily,
    model: fallbackModel,
    maxIdleMs: 0,
    totalIdleMs: 0,
    activityEvents: 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedReadTokens: usage.cachedReadTokens ?? 0,
    cachedNonReadTokens: usage.cachedNonReadTokens ?? 0,
    turnCount: rr.turns ?? 0,
    toolCallCount: Array.isArray(rr.toolCalls) ? rr.toolCalls.length : 0,
    filesReadCount: Array.isArray(rr.filesRead) ? rr.filesRead.length : 0,
    filesWrittenCount: Array.isArray(rr.filesWritten) ? rr.filesWritten.length : 0,
    directoriesListed: 0,
  };
  (rr as { stageStats?: Record<string, unknown> }).stageStats = {
    ...((rr.stageStats as Record<string, unknown> | undefined) ?? {}),
    implementing: synthesized,
  };
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

/**
 * v5 unified `terminalHandler` — single entry point that runs the five
 * terminal side effects in idempotency-safe order and returns the
 * `StageGate<TerminalPayload>` the v5 driver expects.
 *
 * The five sub-handlers above are this function's building blocks: one per
 * side effect, kept individually exported so each can be unit-tested in
 * isolation (tests/lifecycle/handlers/terminal-handlers.test.ts) and so
 * observability AC tests can exercise per-side-effect failures
 * (tests/acceptance/stage-io-observability.test.ts). The unified
 * `terminalHandler` is what STAGE_PLAN's `terminal` stage actually invokes;
 * it sequences the five sub-handlers in idempotency-safe order and folds
 * their state-slot guards into the TerminalPayload shape. Per spec §4.7 the side-effect map carries one
 * boolean per side effect — true = succeeded at least once for this state
 * instance; false = attempted-and-failed or never-attempted-because-context-
 * missing.
 *
 * Idempotency: re-invocation MUST be safe and return the same payload (each
 * sub-handler short-circuits on its state-slot guard, e.g. `state.terminalBlockId`).
 */
export async function terminalHandler(state: LifecycleState): Promise<StageGate<TerminalPayload>> {
  const t0 = Date.now();
  const flags: TerminalPayload = {
    terminalBlockId: null,
    telemetryFlushed: false,
    batchRegistryPersisted: false,
    taskTerminalEmitted: false,
    projectCleanupTicked: false,
  };

  try {
    registerTerminalBlockHandler(state);
    flags.terminalBlockId = (state as { terminalBlockId?: string | null }).terminalBlockId ?? null;
  } catch {
    /* leave null on failure */
  }

  try {
    await flushTelemetryHandler(state);
    flags.telemetryFlushed = (state as { telemetryFlushed?: boolean }).telemetryFlushed === true;
  } catch {
    /* leave false */
  }

  try {
    persistToBatchRegistryHandler(state);
    flags.batchRegistryPersisted = (state as { batchRegistryPersisted?: boolean }).batchRegistryPersisted === true;
  } catch {
    /* leave false */
  }

  try {
    emitTaskTerminalHandler(state);
    flags.taskTerminalEmitted = (state as { taskTerminalEmitted?: boolean }).taskTerminalEmitted === true;
  } catch {
    /* leave false */
  }

  try {
    await recordTaskCompletedHandler(state);
    flags.projectCleanupTicked = true;                          // record-completed doubles as project activity tick
  } catch {
    /* leave false */
  }

  return {
    outcome: 'advance',
    payload: flags,
    telemetry: {
      stageLabel: 'terminal',
      durationMs: Date.now() - t0,
      costUSD: 0,
      turnsUsed: 0,
      stopReason: 'normal',
    },
  };
}
