// v5 lifecycle driver — walks STAGE_PLAN (StageDefinition[]) applying
// Layer-1 (applicableRoutes) then Layer-2 (shouldRun) per spec §4.4.

import type { LifecycleState } from './stage-plan-types.js';
import type { StageGate, StageDefinition, RouteName } from './stage-io.js';
import type { ExecutionContext } from './lifecycle-context.js';
import type { StageLabel } from './stage-labels.js';
import type { TaskEnvelopeStore, StageName as EnvelopeStageName, AgentTier } from '../events/task-envelope.js';
import { ContextBlockNotFoundError } from '../stores/context-block-tool.js';
import { GuardError } from '../bounded-execution/wall-clock-guard.js';

/** Map raw STAGE_PLAN row name → TaskEnvelope StageName. Mirrors VISIBLE_STAGE_LABEL
 *  but typed against the envelope's closed enum. */
const ENVELOPE_STAGE_NAME: Record<string, EnvelopeStageName> = {
  implement: 'implementing',
  review: 'reviewing',
  rework: 'reworking',
  commit: 'committing',
  annotate: 'annotating',
};

function getEnvelope(ctx: ExecutionContext | undefined): TaskEnvelopeStore | undefined {
  return (ctx as { envelope?: TaskEnvelopeStore } | undefined)?.envelope;
}

function envelopeOutcome(gateOutcome: 'advance' | 'skip' | 'halt'): 'advance' | 'fail' | 'skipped' {
  if (gateOutcome === 'advance') return 'advance';
  if (gateOutcome === 'skip') return 'skipped';
  return 'fail';
}

/** Maps STAGE_PLAN row name → visible heartbeat stage label. Only stages
 *  that appear here count toward the user-visible (N/M) progress counter
 *  and trigger heartbeat.transition() from the driver. The other four
 *  rows (prepare, register-block, compose, terminal) are bookkeeping. */
const VISIBLE_STAGE_LABEL: Record<string, StageLabel> = {
  implement: 'implementing',
  review: 'review',
  rework: 'rework',
  commit: 'committing',
  annotate: 'annotating',
};

function isVisibleStage(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VISIBLE_STAGE_LABEL, name);
}

/** Returns a promise that rejects when the signal aborts. Lets stage-handler
 *  awaits unwind on watchdog abort even when the handler itself does not
 *  observe the signal directly. Stays pending forever if no signal. */
function abortAsRejection(signal: AbortSignal | undefined, message: string): Promise<never> {
  if (!signal) return new Promise(() => { /* never resolves */ });
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new Error(message)); return; }
    signal.addEventListener('abort', () => reject(new Error(message)), { once: true });
  });
}

/**
 * Walk `plan` in order. For each stage:
 *   1. If halted and not `runOnHalt`, silently skip (no gate recorded).
 *   2. Layer-1 — check `applicableRoutes`; record a skip gate when route
 *      doesn't apply.
 *   3. Layer-2 — call `shouldRun(state)`; record a skip gate when it
 *      returns `{run: false}`.
 *   4. Run the handler; record the returned gate. Halts set `state.halted`.
 *
 * Handler exceptions become halt gates (except `ContextBlockNotFoundError`,
 * which propagates so the dispatcher can return a structured 400).
 */
export async function runStagePlan(
  plan: StageDefinition<unknown>[],
  initial: LifecycleState,
): Promise<LifecycleState> {
  const state = initial;
  if (!state.gates) (state as { gates?: Record<string, StageGate<unknown>> }).gates = {};
  if (state.halted === undefined) (state as { halted?: boolean }).halted = false;

  const route = (state.route as RouteName | undefined) ?? 'delegate';

  // Initial upper bound: count every STAGE_PLAN row whose name is in
  // VISIBLE_STAGE_LABEL AND whose applicableRoutes match the current
  // route. shouldRun() decisions arrive later (state-dependent); we
  // decrement `visibleTotal` on every visible skip we encounter.
  let visibleRan = 0;
  let visibleTotal = plan.filter((s) =>
    isVisibleStage(s.name) &&
    (s.applicableRoutes === 'all' ||
     (s.applicableRoutes as readonly string[]).includes(route)),
  ).length;

  // Publish the planned visible-stage total to the envelope so the batch
  // progress headline reports a stable denominator (stages-planned) rather
  // than a running tally of stages-recorded-so-far. Re-published on every
  // skip below, mirroring how the heartbeat decrements visibleTotal.
  const publishStageTotal = () =>
    getEnvelope(state.executionContext as ExecutionContext | undefined)?.setPlannedStageTotal(visibleTotal);
  publishStageTotal();

  for (const stage of plan) {
    if (state.halted && !stage.runOnHalt) continue;

    const applies = stage.applicableRoutes === 'all'
      ? true
      : (stage.applicableRoutes as readonly string[]).includes(route);
    if (!applies) {
      const skipGate: StageGate<null> = {
        outcome: 'skip',
        comment: `${stage.name} does not apply to route=${route}`,
        payload: null,
        telemetry: { stageLabel: stage.name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
      };
      state.gates![stage.name] = skipGate;
      recordStageOnEnvelope(state, stage.name, skipGate, 'not_applicable');
      if (isVisibleStage(stage.name)) { visibleTotal -= 1; publishStageTotal(); }
      continue;
    }

    const decision = stage.shouldRun(state);
    if (!decision.run) {
      const skipGate: StageGate<null> = {
        outcome: 'skip',
        comment: decision.comment,
        payload: null,
        telemetry: { stageLabel: stage.name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' },
      };
      state.gates![stage.name] = skipGate;
      recordStageOnEnvelope(state, stage.name, skipGate, decision.skipReason ?? 'noop');
      if (isVisibleStage(stage.name)) { visibleTotal -= 1; publishStageTotal(); }
      continue;
    }

    // Start-of-stage envelope notification (visible stages only).
    if (isVisibleStage(stage.name)) {
      const envelope = getEnvelope(state.executionContext as ExecutionContext | undefined);
      const envelopeName = ENVELOPE_STAGE_NAME[stage.name];
      if (envelope && !envelope.isSealed() && envelopeName) {
        try {
          const round = envelopeName === 'reviewing' || envelopeName === 'reworking'
            ? ((state as { reviewRound?: number }).reviewRound ?? 1)
            : 1;
          // Tier source: ctx.assignedTier holds the route's resolved tier slot
          // ('standard' | 'complex'). `provider.tier` doesn't exist on the
          // Provider type — reading it always returned undefined and defaulted
          // to 'standard', mis-labeling every complex-tier implementing stage.
          const ctx = state.executionContext as { implementerProvider?: { config?: { model?: string } }; assignedTier?: AgentTier } | undefined;
          const provider = ctx?.implementerProvider;
          envelope.startStage(envelopeName, {
            model: provider?.config?.model ?? '',
            tier: ctx?.assignedTier ?? 'standard',
            round,
          });
        } catch { /* envelope errors must not abort lifecycle */ }
      }
    }

    if (isVisibleStage(stage.name)) {
      visibleRan += 1;
      const wireStage = VISIBLE_STAGE_LABEL[stage.name];
      const tracker = (state.executionContext as { heartbeat?: { transition: (f: Record<string, unknown>) => void } } | undefined)?.heartbeat;
      if (tracker) {
        try {
          const transitionFields: Record<string, unknown> = {
            stage: wireStage,
            stageIndex: visibleRan,
            stageCount: Math.max(visibleRan, visibleTotal),
          };
          // review/rework require reviewRound + attemptCap (enforced by
          // ActivityTracker.transition). Default to 1/1 — handlers do not
          // currently track multi-round review state on state.reviewRound.
          if (wireStage === 'review' || wireStage === 'rework') {
            const stateAny = state as { reviewRound?: number; attemptCap?: number };
            transitionFields.reviewRound = stateAny.reviewRound ?? 1;
            transitionFields.attemptCap = stateAny.attemptCap ?? 1;
          }
          tracker.transition(transitionFields);
        } catch (e) {
          // Heartbeat errors must not abort the lifecycle. Mirror the
          // safeTracker pattern from perform-implementation.ts.
          const logger = (state.executionContext as { logger?: { error: (kind: string, err: unknown) => void } } | undefined)?.logger;
          logger?.error?.('heartbeat_transition_failed', e);
        }
      }
    }

    // Wall-clock guard before each non-runOnHalt stage.
    const ctx = state.executionContext as ExecutionContext | undefined;
    if (ctx?.wallClockGuard && !stage.runOnHalt) {
      try {
        ctx.wallClockGuard.checkOrThrow();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const timeoutKind = err instanceof GuardError && err.errorCode === 'guard_wall_clock' ? 'wall_clock' : 'unknown';
        const haltGate: StageGate<null> = {
          outcome: 'halt',
          comment: `${stage.name} halted: ${msg}`,
          payload: null,
          telemetry: { stageLabel: stage.name, durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'timeout', timeoutKind },
        };
        state.gates![stage.name] = haltGate;
        state.halted = true;
        recordStageOnEnvelope(state, stage.name, haltGate);
        continue;
      }
    }

    const t0 = Date.now();
    try {
      const stallSignal = (state.executionContext as ExecutionContext | undefined)?.stall?.controller?.signal;
      const gate = await Promise.race([
        stage.handler(state),
        abortAsRejection(stallSignal, `stage ${stage.name} aborted by stall watchdog`),
      ]);
      state.gates![stage.name] = gate;
      recordStageOnEnvelope(state, stage.name, gate);
      if (gate.outcome === 'halt') {
        state.halted = true;
      }
    } catch (err) {
      if (err instanceof ContextBlockNotFoundError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const tCatch = Date.now() - t0;
      const haltGate: StageGate<null> = {
        outcome: 'halt',
        comment: `${stage.name} crashed: ${msg}`,
        payload: null,
        telemetry: { stageLabel: stage.name, durationMs: tCatch, costUSD: 0, turnsUsed: 0, stopReason: 'transport_error' },
      };
      state.gates![stage.name] = haltGate;
      recordStageOnEnvelope(state, stage.name, haltGate);
      state.halted = true;
      state.terminal = true;
    }
  }

  return state;
}

/** Record this stage's outcome on the TaskEnvelope. Visible stages were already
 *  started via envelope.startStage(); we complete them here. Non-visible stages
 *  (prepare, register-block, compose, terminal) are bookkeeping and not recorded
 *  on the envelope at all — they don't appear in the wire-schema stages array. */
function recordStageOnEnvelope(
  state: LifecycleState,
  rawName: string,
  gate: StageGate<unknown>,
  skipReason?: 'noop' | 'no_command' | 'not_applicable' | 'reviewPolicy_none',
): void {
  const envelopeName = ENVELOPE_STAGE_NAME[rawName];
  if (!envelopeName) return;  // bookkeeping stage — skip envelope
  const envelope = getEnvelope(state.executionContext as ExecutionContext | undefined);
  if (!envelope || envelope.isSealed()) return;
  const round = envelopeName === 'reviewing' || envelopeName === 'reworking'
    ? ((state as { reviewRound?: number }).reviewRound ?? 1)
    : 1;
  // If startStage was not called (e.g. skip-on-not-applicable hits before the
  // visible-stage check above), start it now so completeStage has a stage row
  // to update.
  const snap = envelope.snapshot();
  if (!snap.stages.some(s => s.name === envelopeName && s.round === round)) {
    const ctx2 = state.executionContext as { implementerProvider?: { config?: { model?: string } }; assignedTier?: AgentTier } | undefined;
    const provider = ctx2?.implementerProvider;
    try {
      envelope.startStage(envelopeName, {
        model: provider?.config?.model ?? '',
        tier: ctx2?.assignedTier ?? 'standard',
        round,
      });
    } catch { return; }
  }
  // Per-stage tokens/cost/turnCount come from state.lastRunResult.stageStats,
  // populated by mergeStageStats inside each stage handler (perform-implementation,
  // annotate-stage, etc.). Without pulling these in here, the envelope stage
  // record stays at zero for tokens — even though the runtime captured real
  // numbers — which masks usage and breaks tier-rollup aggregation downstream.
  // mergeStageStats keys: 'implementing' | 'review' | 'rework' | 'annotating' | 'committing'.
  const stageStatsKey: Record<string, string> = {
    implementing: 'implementing',
    reviewing: 'review',
    reworking: 'rework',
    annotating: 'annotating',
    committing: 'committing',
  };
  const lastRunResult = (state as { lastRunResult?: { stageStats?: Record<string, Record<string, unknown> | undefined> } }).lastRunResult;
  const stats = lastRunResult?.stageStats?.[stageStatsKey[envelopeName] ?? envelopeName];

  const numericOrUndef = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const numericNullable = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  // Reviewer cross-tier inversion: the review handler picks the inverted tier
  // at dispatch time and writes the actual reviewer's tier + model into
  // stageStats. The envelope row was originally stamped with the implementer's
  // tier (from ctx.assignedTier) during startStage; overwrite with the
  // reviewer's actual tier here so tierUsage rollup attributes review cost
  // to the correct tier bucket.
  const statsTier = stats?.['agentTier'];
  const statsModel = stats?.['model'];
  const wireTier = (statsTier === 'standard' || statsTier === 'complex') ? statsTier as AgentTier : undefined;
  const wireModel = typeof statsModel === 'string' && statsModel.length > 0 ? statsModel : undefined;
  // Verdict (review stage only): set by review-stage via mergeStageStats's
  // verdict option. Other stages don't set this and we leave the field as-is.
  const statsVerdict = stats?.['verdict'];
  const wireVerdict: 'approved' | 'changes_required' | 'concerns' | 'error' | undefined =
    statsVerdict === 'approved' || statsVerdict === 'changes_required' || statsVerdict === 'concerns' || statsVerdict === 'error'
      ? statsVerdict : undefined;

  try {
    envelope.completeStage(envelopeName, round, {
      outcome: envelopeOutcome(gate.outcome),
      durationMs: gate.telemetry.durationMs,
      costUSD: numericOrUndef(stats?.['costUSD']) ?? gate.telemetry.costUSD ?? 0,
      turnsUsed: numericOrUndef(stats?.['turnCount']) ?? gate.telemetry.turnsUsed ?? 0,
      ...(wireTier && { tier: wireTier }),
      ...(wireModel && { model: wireModel }),
      ...(wireVerdict && { verdict: wireVerdict }),
      ...(stats?.['inputTokens'] !== undefined && { inputTokens: numericOrUndef(stats['inputTokens']) ?? 0 }),
      ...(stats?.['outputTokens'] !== undefined && { outputTokens: numericOrUndef(stats['outputTokens']) ?? 0 }),
      ...(stats?.['cachedReadTokens'] !== undefined && { cachedReadTokens: numericNullable(stats['cachedReadTokens']) ?? null }),
      ...(stats?.['cachedNonReadTokens'] !== undefined && { cachedNonReadTokens: numericNullable(stats['cachedNonReadTokens']) ?? null }),
      ...(stats?.['findingsOutcome'] !== undefined && { findingsOutcome: stats['findingsOutcome'] as 'clean' | 'found' | 'not_applicable' | null | undefined }),
      ...(stats?.['findingsOutcomeReason'] !== undefined && { findingsOutcomeReason: stats['findingsOutcomeReason'] as string | null | undefined }),
      ...(stats?.['outcomeInferred'] !== undefined && { outcomeInferred: stats['outcomeInferred'] as boolean | undefined }),
      ...(stats?.['outcomeMalformed'] !== undefined && { outcomeMalformed: stats['outcomeMalformed'] as boolean | undefined }),
      // Don't include filesWrittenCount here — it's accumulated incrementally
      // by envelope.recordToolCall() and would be clobbered by Object.assign.
      // mergeStageStats tracks it; the session-side accumulation is the source
      // of truth in flight.
      ...(skipReason && gate.outcome === 'skip' ? { skipReason } : {}),
    });
  } catch { /* sealed during the call; harmless */ }
}

