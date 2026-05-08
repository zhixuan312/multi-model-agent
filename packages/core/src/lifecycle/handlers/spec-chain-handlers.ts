import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { pickReviewer, pickEscalation } from '../../escalation/policy.js';
import type { ReviewerCallResult, ReviewRoute } from '../../review/reviewer-engine.js';
import { ReviewerParseError } from '../../review/reviewer-engine.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import {
  runWithFallback,
  TRANSPORT_FAILURES,
  isReviewTransportFailure,
  makeSyntheticRunResult,
  type UnavailableMap,
} from '../../escalation/fallback.js';
import { makeSkippedReviewResult, type SkippedReviewResult } from '../../review/skipped-result.js';
import { makeRunnerShell } from '../../providers/make-runner-shell.js';
import { mergeStageStats, replaceLastRunResultPreservingTrackers } from '../merge-stage-stats.js';

/**
 * Spec-chain handlers (#45 Step 4a).
 *
 * Six StagePlan rows are wired here:
 *   - 4.1 spec_review_round_1
 *   - 4.2 rework_for_spec_round_1
 *   - 4.3 spec_review_round_2
 *   - 4.4 rework_for_spec_round_2
 *   - 4.5 spec_review_round_3
 *   - 4.6 settle_spec_chain
 *
 * Each review handler wraps the shared `runSpecReviewRound` helper that
 * picks the reviewer per spec C9 (rotation timing: tier swap at round 3 /
 * attemptIndex 2), pulls the implementer report from state.lastRunResult,
 * and writes the round's verdict slot.
 *
 * Each rework handler builds a rework brief from the prior round's verdict
 * and delegates via pickEscalation. Per #45 Step 0:
 *   - Spec rework_1 uses attemptIndex 1 (specChainAttemptIndex initialized
 *     to 1 after the initial impl).
 *   - Spec rework_2 uses attemptIndex 2.
 *
 * Settle handler aggregates the three round verdicts into state.specChainPassed
 * per the cascade rule: any 'approved' wins; 'changes_required' through round
 * 3 ⇒ false; 'error' is hard-fail (terminal).
 *
 * Idempotency: each handler skips when its verdict slot is already
 * populated. Prevents re-firing reviewer turns on retry paths.
 *
 * Defensive no-ops: when state.task, state.executionContext, or
 * state.lastRunResult is missing, the handler short-circuits.
 */

interface ReviewRoundInput {
  state: LifecycleState;
  ctx: ExecutionContext;
  round: 1 | 2 | 3;
}

async function runSpecReviewRound(input: ReviewRoundInput): Promise<ReviewerCallResult | null> {
  const { state, ctx, round } = input;
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return null;

  const baseTier: AgentType = ctx.assignedTier;
  const reviewerTier = pickReviewer({ loop: 'spec', attemptIndex: round - 1, baseTier });

  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  state.specUnavailable ??= new Map() as UnavailableMap;
  const specUnavailable: UnavailableMap = state.specUnavailable;

  // Tool sweep #6: produce the cumulative diff so the reviewer sees
  // the actual code change, not just the worker's text claim. Empty
  // string when no diff tracker (read-only routes) or no changes.
  let cumulativeDiff = '';
  if (state.diffTracker) {
    try {
      cumulativeDiff = await state.diffTracker.cumulativeDiff();
    } catch {
      // Diff failures shouldn't block review. Falls back to text-only.
    }
  }
  const priorConcerns = Array.isArray(state.priorSpecConcerns) ? state.priorSpecConcerns : [];

  const reviewerCall = await runWithFallback<ReviewerCallResult | SkippedReviewResult>({
    assigned: reviewerTier,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: specUnavailable,
    isTransportFailure: (r) => isReviewTransportFailure(r as { status?: string }),
    getStatus: (r) => (r as { status?: RunResult['status'] }).status,
    makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
    call: async (provider, usedTier) => {
      const shell = makeRunnerShell(provider);
      const engine = ctx.reviewerEngine;
      if (!engine) throw new Error('reviewerEngine not configured');
      try {
        return engine.runSpec(shell, {
          workerOutput: last.output,
          brief: task.prompt ?? '',
          cwd: ctx.cwd,
          route: (state.route ?? ctx.route) as ReviewRoute,
          diff: cumulativeDiff,
          priorConcerns,
          abortSignal: ctx.stall.controller.signal,
          deadlineMs: ctx.timing.deadlineMs,
          ...(ctx.bus && { bus: ctx.bus }),
          ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
          tier: usedTier,
          stageLabel: 'Spec review',
        });
      } catch (err) {
        if (err instanceof ReviewerParseError) {
          return { verdict: 'error' as const, concerns: [] } as unknown as ReviewerCallResult;
        }
        throw err;
      }
    },
  });

  if (reviewerCall.bothUnavailable) return null;
  const out = reviewerCall.result;
  if ('status' in out && out.status === 'skipped') return null;
  return out as ReviewerCallResult;
}

async function runSpecRework(input: ReviewRoundInput): Promise<RunResult | null> {
  const { state, ctx, round } = input;
  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  const attemptIndex = round - 1; // rework_1 → attemptIndex 1, rework_2 → attemptIndex 2
  const baseTier: AgentType = ctx.assignedTier;
  const decision = pickEscalation({ loop: 'spec', attemptIndex, baseTier });

  state.specChainAttemptIndex = attemptIndex;
  state.specUnavailable ??= new Map() as UnavailableMap;
  const specUnavailable: UnavailableMap = state.specUnavailable;

  const reworkPrompt = (task.prompt ?? '') + '\n\n[spec rework — address the prior reviewer feedback]';
  const reworkTask: TaskSpec = { ...task, prompt: reworkPrompt };

  const reworkCall = await runWithFallback<RunResult>({
    assigned: decision.impl,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: specUnavailable,
    isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.incompleteReason === undefined,
    getStatus: (r) => r.status,
    makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'),
    call: (provider, usedTier) =>
      delegateWithEscalation(
        {
          prompt: reworkTask.prompt,
          cwd: ctx.cwd,
          agentType: usedTier,
          briefQualityPolicy: 'off',
          timeoutMs: ctx.timing.timeoutMs,
        },
        [provider],
        {
          explicitlyPinned: true,
          taskDeadlineMs: ctx.timing.deadlineMs,
          abortSignal: ctx.stall.controller.signal,
          assignedTier: usedTier,
          // Without bus the rework's runner-shell.emit calls go nowhere — the
          // implementer turns then run silently, the reviewer keeps seeing
          // (slightly) updated code, and the chain marches through 3 rounds
          // with no visible Implementing events. Pass the same bus + ids the
          // initial-impl call uses so verbose stderr + the running headline
          // surface the rework's progress.
          ...(ctx.bus && { bus: ctx.bus }),
          ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
          ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
          stageLabel: `Spec rework round ${round - 1}`,
        },
      ),
  });

  if (reworkCall.bothUnavailable) return null;
  const result = reworkCall.result;
  if (result.status !== 'ok') return null;
  return result;
}

function makeSpecReviewHandler(round: 1 | 2 | 3) {
  const slot = `specReviewRound${round}Verdict` as const;
  return async function specReviewRoundHandler(state: LifecycleState): Promise<void> {
    if (state[slot]) return; // idempotency
    const ctx = state.executionContext;
    if (!ctx) return; // defensive no-op
    const result = await runSpecReviewRound({ state, ctx, round });
    if (!result) return;
    state[slot] = result.verdict;
    // Tool sweep #6: accumulate concerns across rounds so the next
    // reviewer can verify the rework addressed each one. We append
    // unique concerns (skip duplicates from earlier rounds).
    if (Array.isArray(result.concerns) && result.concerns.length > 0) {
      const prior = Array.isArray(state.priorSpecConcerns) ? state.priorSpecConcerns : [];
      const seen = new Set(prior);
      const merged = [...prior];
      for (const c of result.concerns) {
        if (typeof c === 'string' && !seen.has(c)) {
          seen.add(c);
          merged.push(c);
        }
      }
      state.priorSpecConcerns = merged;
    }
    // Persist concerns into lastRunResult so the wire's per-stage
    // findingsBySeverity (driven by rr.concerns) reflects what the
    // reviewer raised — without this, findings_critical/high/medium/low
    // for spec_review stays 0 even on changes_required outcomes.
    persistSpecReviewConcerns(state, result);
    // Record per-round cost so wire task.completed sums reviewer tokens
    // and the spec_review stage entry has cumulative roundsUsed across
    // 1..3 rounds. Reviewer tier is derived from policy (round-based).
    const baseTier: AgentType = ctx.assignedTier;
    const reviewerTier = (round - 1 < 2)
      ? (baseTier === 'standard' ? 'complex' : 'standard')
      : baseTier; // round 3 swaps back to base tier per SPEC_LOOP policy
    const reviewerProvider = ctx.providers[reviewerTier];
    mergeStageStats(state, 'spec_review', {
      inputTokens: result.cost?.inputTokens ?? 0,
      outputTokens: result.cost?.outputTokens ?? 0,
      turnCount: result.cost?.turnCount ?? 0,
      toolCallCount: result.cost?.toolCallCount ?? 0,
      costUSD: result.cost?.costUSD ?? null,
      durationMs: result.cost?.durationMs ?? null,
    }, {
      tier: reviewerTier,
      model: (reviewerProvider?.config as { model?: string } | undefined)?.model ?? null,
      verdict: result.verdict,
    });
  };
}

/** Push reviewer concerns into state.lastRunResult.concerns so the wire
 *  findingsBySeverity bucket for spec_review counts them. Spec reviewer
 *  emits free-text concerns (no per-item severity), so we default to
 *  'medium' — this matches the v3.x defaulting in event-builder. */
function persistSpecReviewConcerns(state: LifecycleState, result: ReviewerCallResult): void {
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return;
  const reviewerConcerns = result.concerns;
  if (!Array.isArray(reviewerConcerns) || reviewerConcerns.length === 0) return;
  const newConcerns = reviewerConcerns.map(text => ({
    source: 'spec_review' as const,
    severity: 'medium' as const,
    message: text,
  }));
  last.concerns = [...(last.concerns ?? []), ...newConcerns];
}

function makeSpecReworkHandler(round: 1 | 2) {
  return async function specReworkHandler(state: LifecycleState): Promise<void> {
    const ctx = state.executionContext;
    if (!ctx) return;
    const newResult = await runSpecRework({ state, ctx, round: (round + 1) as 2 | 3 });
    if (!newResult) {
      // The rework's implementer call did not return an ok RunResult.
      // Don't silently fall through to the next review round — that would
      // re-review the unchanged code and produce the "3 reviews, 0 reworks"
      // pattern. Mark the chain failed so the next round's `!s.terminal`
      // gate stops the cascade and settle_spec_chain can record the
      // failure on the wire envelope.
      state.specReworkFailed = true;
      state.terminal = true;
      if (ctx.verbose && typeof ctx.verboseStream === 'function') {
        ctx.verboseStream(
          `[mmagent verbose] event=spec_rework_failed ts=${new Date().toISOString()} batch_id=${ctx.batchId ?? ''} task_index=${ctx.taskIndex ?? 0} round=${round}\n`,
        );
      }
      return;
    }
    // Tool sweep #6: union filesRead/filesWritten/toolCalls + preserve
    // stageStats. Pre-fix this branch only kept stageStats and dropped
    // file-tracker arrays — a spec-rework with 0 writes wiped the
    // implementer's recorded write, the envelope's filesWritten went
    // empty, and downstream qualityReviewStatus reported "no file
    // artifacts to review" despite the file being modified on disk.
    replaceLastRunResultPreservingTrackers(state, newResult);
    // Record rework cost in spec_rework stage stats so wire telemetry sees
    // it. round=1 → attemptIndex 1, round=2 → attemptIndex 2; rework tier
    // mirrors pickEscalation (impl=standard for attemptIndex 1; impl=complex
    // for attemptIndex 2 when baseTier=standard).
    const baseTier: AgentType = ctx.assignedTier;
    const reworkTier: AgentType = (round === 2 && baseTier === 'standard') ? 'complex' : baseTier;
    const reworkProvider = ctx.providers[reworkTier];
    mergeStageStats(state, 'spec_rework', {
      inputTokens: newResult.usage?.inputTokens ?? 0,
      outputTokens: newResult.usage?.outputTokens ?? 0,
      cachedReadTokens: newResult.usage?.cachedReadTokens ?? 0,
      cachedNonReadTokens: newResult.usage?.cachedNonReadTokens ?? 0,
      turnCount: newResult.turns ?? 0,
      toolCallCount: Array.isArray(newResult.toolCalls) ? newResult.toolCalls.length : 0,
      costUSD: newResult.cost?.costUSD ?? null,
      durationMs: newResult.durationMs ?? null,
      filesReadCount: Array.isArray(newResult.filesRead) ? newResult.filesRead.length : 0,
      filesWrittenCount: Array.isArray(newResult.filesWritten) ? newResult.filesWritten.length : 0,
    }, {
      tier: reworkTier,
      model: (reworkProvider?.config as { model?: string } | undefined)?.model ?? null,
    });
  };
}

export const specReviewRound1Handler = makeSpecReviewHandler(1);
export const specReviewRound2Handler = makeSpecReviewHandler(2);
export const specReviewRound3Handler = makeSpecReviewHandler(3);
export const specReworkRound1Handler = makeSpecReworkHandler(1);
export const specReworkRound2Handler = makeSpecReworkHandler(2);

/**
 * Settle handler (row 4.6). Reads the three round verdicts and writes
 * state.specChainPassed.
 *
 * Cascade rule:
 *   - Any 'approved' verdict in the chain ⇒ chain passed (true)
 *   - 'changes_required' through round 3 ⇒ chain failed (false)
 *   - 'error' in any round ⇒ chain failed (false), state.terminal = true
 *
 * Runs runOnTerminal so the chain-pass slot is authoritative even on
 * hard-fail paths. Idempotent: skips when state.specChainPassed is
 * already populated.
 */
export function settleSpecChainHandler(state: LifecycleState): void {
  if (typeof state.specChainPassed === 'boolean') return; // idempotency
  const v1 = state.specReviewRound1Verdict;
  const v2 = state.specReviewRound2Verdict;
  const v3 = state.specReviewRound3Verdict;

  if (v1 === undefined && v2 === undefined && v3 === undefined) return; // defensive no-op

  if (v1 === 'approved' || v2 === 'approved' || v3 === 'approved') {
    state.specChainPassed = true;
    return;
  }
  if (v1 === 'error' || v2 === 'error' || v3 === 'error') {
    state.specChainPassed = false;
    state.terminal = true;
    return;
  }
  state.specChainPassed = false;
}
