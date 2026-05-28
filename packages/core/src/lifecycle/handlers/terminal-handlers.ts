import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { RuntimeRunResult, TaskSpec } from '../../types.js';
import type { StageGate, TerminalPayload } from '../stage-io.js';
import { findModelProfile } from '../../config/model-profile-registry.js';
import { getRealFilesChanged } from '../real-diff.js';
import { deriveCompletion, extractCompletionInputs } from '../derive-completion.js';
import { TerminalBlockRegistrar } from '../../reporting/terminal-block-registrar.js';
import { renderTerminalReportMarkdown } from '../../reporting/terminal-report-markdown.js';
import { WRITE_ROUTES } from '../stage-io.js';
import { findEscapedWrites } from '../file-confinement-check.js';
import type { ErrorCode } from '../../error-codes.js';

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
 *   - state.contextBlockId
 *   - state.taskTerminalEmitted
 *   - state.batchRegistryPersisted
 *   - state.telemetryFlushed
 *
 * Defensive no-ops on missing state.executionContext or
 * state.lastRunResult. All four rows are marked runOnTerminal in the
 * StagePlan, so they fire even on hard-fail paths.
 */

export function registerTerminalBlockHandler(state: LifecycleState): void {
  if (state.contextBlockId) return;
  const ctx = state.executionContext;
  const envelope = ctx?.envelope;
  const store = ctx?.contextBlockStore;
  const registry = ctx?.batchRegistry;
  if (!envelope || !store || !registry) return;
  const snap = envelope.snapshot();
  // Write routes (delegate / execute-plan / retry) produce code + a commit;
  // their durable record is the diff, not a prose block. No registration.
  if ((WRITE_ROUTES as readonly string[]).includes(snap.route)) return;
  try {
    const markdown = renderTerminalReportMarkdown(snap);
    const registrar = new TerminalBlockRegistrar(store, registry);
    const id = registrar.register({
      batchId: snap.batchId, taskIndex: snap.taskIndex, route: snap.route, markdown,
    });
    if (id) state.contextBlockId = id;
  } catch {
    // Best-effort: registration is advisory and must not block seal/flush/persist.
    envelope.recordValidationWarning({
      rule: 'TerminalBlockRegisterFailed',
      path: `${snap.route}:${snap.batchId}:${snap.taskIndex}`,
    });
  }
}

export function emitTaskTerminalHandler(state: LifecycleState): void {
  if (state.taskTerminalEmitted) return;
  const ctx = state.executionContext;
  if (!ctx) return;
  // The old `task_completed` named event was replaced by the sealed-envelope
  // snapshot push inside envelope.seal() (see recordTaskCompletedHandler); the
  // TelemetryUploader subscriber picks up that snapshot and runs toWireRecord.
  // No bus.emit happens here — the envelope IS the event. This handler now only
  // marks the idempotency flag so re-runs are no-ops.
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
 * Row 5.6 — record_task_completed → envelope.seal.
 *
 * Seals the per-task envelope to finalize all accumulated state and
 * trigger telemetry upload via TelemetryUploader subscriber. Idempotent on
 * state.taskCompletedRecorded. No-op when the server hasn't supplied an
 * envelope (CLI/test paths).
 */
export async function recordTaskCompletedHandler(state: LifecycleState): Promise<void> {
  if (state.taskCompletedRecorded) return;
  const ctx = state.executionContext;
  if (!ctx) return;
  const envelope = ctx.envelope;
  if (!envelope) {
    state.taskCompletedRecorded = true;
    return;
  }
  const real = await getRealFilesChanged(state);
  const last = state.lastRunResult as RuntimeRunResult | undefined;
  if (real.source === 'git_error') {
    envelope.recordValidationWarning({ rule: 'GitDiffUnavailable', path: 'realFilesChanged' });
  }
  const completionInputs = extractCompletionInputs(state);
  // Use deriveCompletion when implement gate is populated. commitKind being
  // undefined is legitimate (read routes have no commit stage) — deriveCompletion
  // handles those branches internally. Only fall back to workerStatus when the
  // implement gate itself is missing (lifecycle never started, brief_too_vague paths).
  const hasGateInputs = completionInputs.implementOutcome !== undefined;

  let sealStatus: 'done' | 'done_with_concerns' | 'failed';
  if (hasGateInputs) {
    const { completed } = deriveCompletion(completionInputs);
    const hasConcerns = (state.executionContext?.envelope?.snapshot()?.findings ?? []).length > 0;
    sealStatus = completed ? (hasConcerns ? 'done_with_concerns' : 'done') : 'failed';
  } else {
    // Fallback only when implement gate is missing entirely (brief_too_vague etc.)
    const ws = (state.workerStatus ?? last?.workerStatus) as string | undefined;
    sealStatus = ws === 'done' ? 'done' : ws === 'done_with_concerns' ? 'done_with_concerns' : 'failed';
  }

  // Commit outcome (authoritative, from the commit gate) — computed BEFORE the
  // confinement guard so it can corroborate the worker's self-reported writes.
  // Carried onto the envelope below so the response's structuredReport surfaces
  // the real SHA/message (the response is built from envelope snapshots).
  const commitGate = state.gates?.['commit'];
  const commitPayload = (commitGate?.outcome === 'advance' ? commitGate.payload : null) as
    { kind?: string; commitSha?: string; commitMessage?: string; reason?: string } | null;
  const didCommit = commitPayload?.kind === 'committed';

  // Confinement guard: a worker must only write under its dispatched cwd. A
  // reported write that escaped (e.g. into a sibling git worktree / the daemon's
  // startup cwd) is a real mislocation. BUT the worker-reported filesWritten
  // string is unreliable — LLM workers routinely report normalized/relative/
  // hallucinated absolute paths (e.g. "/repo/src/x.ts" or "/workspace/src/x.ts")
  // for a file actually written under the dispatched cwd. So hard-fail ONLY when
  // the worker claims an escaped write AND no commit landed in cwd (didCommit =
  // false → the write is not in this repo → it genuinely wrote elsewhere). When a
  // commit DID land in cwd, the self-reported path is a hallucination — record an
  // advisory warning rather than failing a legitimate, committed task on an
  // unreliable self-report string. (The git commit is the authoritative signal.)
  let escapeErrorCode: ErrorCode | null = null;
  const escaped = findEscapedWrites(last?.filesWritten ?? [], ctx.cwd);
  if (escaped.length > 0) {
    envelope.recordValidationWarning({ rule: 'WorkerWriteEscapedCwd', path: escaped.join(', ') });
    if (!didCommit) {
      sealStatus = 'failed';
      escapeErrorCode = 'tool_sandbox_cwd_violation';
    }
  }

  envelope.seal({
    status: sealStatus,
    terminalAt: new Date().toISOString(),
    stopReason: last?.terminationReason?.cause ?? null,
    structuredError: last?.structuredError ?? null,
    errorCode: escapeErrorCode ?? (last as { errorCode?: ErrorCode | null } | undefined)?.errorCode ?? null,
    realFilesChanged: real.files,
    commitSha: didCommit ? (commitPayload?.commitSha ?? null) : null,
    commitMessage: didCommit ? (commitPayload?.commitMessage ?? null) : null,
    commitSkipReason: commitPayload?.kind === 'no_op' ? (commitPayload?.reason ?? null) : null,
    contextBlockId: state.contextBlockId ?? null,
  });
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
 * sub-handler short-circuits on its state-slot guard, e.g. `state.contextBlockId`).
 */
export async function terminalHandler(state: LifecycleState): Promise<StageGate<TerminalPayload>> {
  const t0 = Date.now();
  const flags: TerminalPayload = {
    contextBlockId: null,
    telemetryFlushed: false,
    batchRegistryPersisted: false,
    taskTerminalEmitted: false,
    projectCleanupTicked: false,
  };

  try {
    registerTerminalBlockHandler(state);
    flags.contextBlockId = (state as { contextBlockId?: string | null }).contextBlockId ?? null;
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
