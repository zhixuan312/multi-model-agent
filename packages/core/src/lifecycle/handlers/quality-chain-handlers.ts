import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { pickReviewer, pickEscalation } from '../../escalation/policy.js';
import { ReviewerEngine, type ReviewerCallResult, type ReviewRoute } from '../../review/reviewer-engine.js';
import { ReviewerParseError } from '../../review/reviewer-engine.js';
import { AnnotatorEngine, type AnnotatorCallResult } from '../../review/annotator-engine.js';
import type { AnnotatorRoute } from '../../review/annotator-prompt-builder.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import {
  runWithFallback,
  TRANSPORT_FAILURES,
  isReviewTransportFailure,
  makeSyntheticRunResult,
  type UnavailableMap,
} from '../../escalation/fallback.js';
import { makeSkippedReviewResult } from '../../review/skipped-result.js';
import type { SkippedReviewResult } from '../../review/skipped-result.js';
import { makeRunnerShell } from '../../providers/make-runner-shell.js';
import { mergeStageStats, replaceLastRunResultPreservingTrackers } from '../merge-stage-stats.js';

/**
 * Quality-chain handlers (#45 Step 4b).
 *
 * Six StagePlan rows are wired here:
 *   - 4.7  quality_review_round_1
 *   - 4.8  rework_for_quality_round_1
 *   - 4.9  quality_review_round_2
 *   - 4.10 rework_for_quality_round_2
 *   - 4.11 quality_review_round_3
 *   - 4.12 settle_quality_chain
 *
 * Symmetric with spec-chain-handlers, with two important differences:
 *   1. The annotator path (read-only routes — review/audit/debug/etc.) returns
 *      verdict 'annotated', which never matches the rework gate
 *      (`'changes_required'`), so no rework fires for those routes. That's
 *      the intended behavior per #45 Step 0 reconciliation.
 *   2. Quality rework_1 uses attemptIndex 1 — the quality loop's index 0 row
 *      has impl: null (review-only), so pickEscalation throws if asked for
 *      attemptIndex 0.
 *
 * Idempotency on each round verdict slot. Defensive no-ops on missing
 * state.task / state.executionContext / state.lastRunResult / providers.
 */

interface ReviewRoundInput {
  state: LifecycleState;
  ctx: ExecutionContext;
  round: 1 | 2 | 3;
}

async function runQualityReviewRound(input: ReviewRoundInput): Promise<ReviewerCallResult | AnnotatorCallResult | null> {
  const { state, ctx, round } = input;
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return null;
  const implReport = last.implementationReport ?? last.structuredReport;
  if (!implReport) return null;

  const baseTier: AgentType = ctx.assignedTier;
  const reviewerTier = pickReviewer({ loop: 'quality', attemptIndex: round - 1, baseTier });

  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  const route = (state.route ?? ctx.route) as ReviewRoute;
  const isArtifactProducing = state.toolCategory === 'artifact_producing';

  const fileContents: Record<string, string> = {};
  const toolCallLog: string[] = last.toolCalls ?? [];
  const filesWritten: string[] = last.filesWritten ?? [];

  state.qualityUnavailable ??= new Map() as UnavailableMap;
  const qualityUnavailable: UnavailableMap = state.qualityUnavailable;

  // Tool sweep #6: cumulative diff for quality review (artifact-producing
  // routes). Same plumbing as spec-chain — reviewer needs to see the
  // actual code change to make precise findings. Read-only routes don't
  // have a diffTracker, so this is empty for them (and harmless).
  let cumulativeDiff = '';
  if (state.diffTracker) {
    try {
      cumulativeDiff = await state.diffTracker.cumulativeDiff();
    } catch {
      // Diff failures shouldn't block review.
    }
  }
  const priorConcerns = Array.isArray(state.priorQualityConcerns) ? state.priorQualityConcerns : [];

  const reviewerCall = await runWithFallback<ReviewerCallResult | AnnotatorCallResult | SkippedReviewResult>({
    assigned: reviewerTier,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: qualityUnavailable,
    isTransportFailure: (r) => isReviewTransportFailure(r as { status?: string }),
    getStatus: (r) => (r as { status?: RunResult['status'] }).status,
    makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
    call: async (provider, usedTier) => {
      const shell = makeRunnerShell(provider);
      if (isArtifactProducing) {
        const engine = ctx.reviewerEngine;
        if (!engine) throw new Error('reviewerEngine not configured');
        try {
          return engine.runQualityAP(shell, {
            workerOutput: last.output,
            brief: task.prompt ?? '',
            cwd: ctx.cwd,
            route,
            fileContents,
            toolCallLog,
            filesWritten,
            diff: cumulativeDiff,
            priorConcerns,
            abortSignal: ctx.stall.controller.signal,
            deadlineMs: ctx.timing.deadlineMs,
            ...(ctx.bus && { bus: ctx.bus }),
            ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
            tier: usedTier,
            stageLabel: 'Quality review',
          });
        } catch (err) {
          if (err instanceof ReviewerParseError) {
            return { verdict: 'error' as const, concerns: [] } as unknown as ReviewerCallResult;
          }
          throw err;
        }
      }
      const annotator = ctx.annotatorEngine;
      if (!annotator) throw new Error('annotatorEngine not configured');
      return annotator.annotate(shell, {
        workerOutput: last.output,
        brief: task.prompt ?? '',
        cwd: ctx.cwd,
        route: route as AnnotatorRoute,
        abortSignal: ctx.stall.controller.signal,
        deadlineMs: ctx.timing.deadlineMs,
        ...(ctx.bus && { bus: ctx.bus }),
        ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
        tier: usedTier,
        stageLabel: 'Annotating',
      });
    },
  });

  if (reviewerCall.bothUnavailable) return null;
  const out = reviewerCall.result;
  if ('status' in out && out.status === 'skipped') return null;
  return out as ReviewerCallResult | AnnotatorCallResult;
}

async function runQualityRework(state: LifecycleState, ctx: ExecutionContext, attemptIndex: number): Promise<RunResult | null> {
  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  const baseTier: AgentType = ctx.assignedTier;
  const decision = pickEscalation({ loop: 'quality', attemptIndex, baseTier });

  state.qualityChainAttemptIndex = attemptIndex;
  state.qualityUnavailable ??= new Map() as UnavailableMap;
  const qualityUnavailable: UnavailableMap = state.qualityUnavailable;

  const reworkPrompt = (task.prompt ?? '') + '\n\n[quality rework — address the prior reviewer feedback]';

  const reworkCall = await runWithFallback<RunResult>({
    assigned: decision.impl,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: qualityUnavailable,
    isTransportFailure: (r) => TRANSPORT_FAILURES.has(r.status) && r.incompleteReason === undefined,
    getStatus: (r) => r.status,
    makeSyntheticFailure: (assigned) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable'),
    call: (provider, usedTier) =>
      delegateWithEscalation(
        {
          prompt: reworkPrompt,
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
          // Same fix as spec-chain rework — pass bus so runner events fire.
          ...(ctx.bus && { bus: ctx.bus }),
          ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
          ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
          stageLabel: `Quality rework round ${attemptIndex}`,
        },
      ),
  });

  if (reworkCall.bothUnavailable) return null;
  const result = reworkCall.result;
  if (result.status !== 'ok') return null;
  return result;
}

function mapQualityVerdict(result: ReviewerCallResult | AnnotatorCallResult | SkippedReviewResult): LifecycleState['qualityReviewRound1Verdict'] {
  if ('status' in result && result.status === 'skipped') return 'skipped';
  return (result as ReviewerCallResult | AnnotatorCallResult).verdict;
}

function makeQualityReviewHandler(round: 1 | 2 | 3) {
  const slot = `qualityReviewRound${round}Verdict` as const;
  return async function qualityReviewRoundHandler(state: LifecycleState): Promise<void> {
    if (state[slot]) return;
    const ctx = state.executionContext;
    if (!ctx) return;
    const result = await runQualityReviewRound({ state, ctx, round });
    if (!result) return;
    state[slot] = mapQualityVerdict(result);
    // Tool sweep #6: accumulate concerns across rounds for reviewer
    // continuity. Same merge pattern as priorSpecConcerns.
    const concernsList = (result as { concerns?: unknown }).concerns;
    if (Array.isArray(concernsList) && concernsList.length > 0) {
      const prior = Array.isArray(state.priorQualityConcerns) ? state.priorQualityConcerns : [];
      const seen = new Set(prior);
      const merged = [...prior];
      for (const c of concernsList) {
        if (typeof c === 'string' && !seen.has(c)) {
          seen.add(c);
          merged.push(c);
        }
      }
      state.priorQualityConcerns = merged;
    }
    // Persist findings + concerns onto lastRunResult so:
    //   - the wire event-builder's findingsBySeverity (reads rr.concerns)
    //     populates findings_critical/high/medium/low DB columns instead
    //     of zeros even on annotated audit/review/verify/debug/investigate runs;
    //   - the terminal envelope's annotatedFindings field carries the
    //     parsed findings the user can read (was empty before — the
    //     consumer had to fall back to extraSections).
    persistReviewFindings(state, result);
    // Record per-round cost in quality_review stageStats. Annotator path
    // (read-only routes) and reviewer path both share the same stage slot;
    // the verdict differentiates ('annotated' vs 'approved'/'changes_required').
    const baseTier: AgentType = ctx.assignedTier;
    const reviewerTier: AgentType = (round - 1 < 2)
      ? (baseTier === 'standard' ? 'complex' : 'standard')
      : baseTier;
    const reviewerProvider = ctx.providers[reviewerTier];
    const cost = (result as ReviewerCallResult | AnnotatorCallResult).cost;
    mergeStageStats(state, 'quality_review', {
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
      turnCount: cost?.turnCount ?? 0,
      toolCallCount: cost?.toolCallCount ?? 0,
      costUSD: cost?.costUSD ?? null,
      durationMs: cost?.durationMs ?? null,
    }, {
      tier: reviewerTier,
      model: (reviewerProvider?.config as { model?: string } | undefined)?.model ?? null,
      verdict: (result as ReviewerCallResult | AnnotatorCallResult).verdict,
    });
  };
}

/** Push the reviewer/annotator's findings into state.lastRunResult so the
 *  wire telemetry's per-stage `findingsBySeverity` + the terminal envelope's
 *  `annotatedFindings` see them. Without this:
 *    - wire findings_critical/high/medium/low all stay 0 even when the
 *      annotator returned a populated array;
 *    - envelope.results[N].annotatedFindings is empty and consumers have
 *      to mine extraSections to find the data.
 *  Idempotent across rounds (each round appends; the wire dedupes by
 *  per-stage filter so no double-counting). */
function persistReviewFindings(
  state: LifecycleState,
  result: ReviewerCallResult | AnnotatorCallResult | SkippedReviewResult,
): void {
  if ('status' in result && result.status === 'skipped') return;
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return;

  // Annotator result: structured findings array.
  const annotatorFindings = (result as AnnotatorCallResult).annotatedFindings;
  if (Array.isArray(annotatorFindings) && annotatorFindings.length > 0) {
    const merged = [...(last.annotatedFindings ?? []), ...annotatorFindings];
    last.annotatedFindings = merged;
    const newConcerns = annotatorFindings.map(f => ({
      source: 'quality_review' as const,
      severity: ((f as { severity?: string }).severity ?? 'medium') as 'critical' | 'high' | 'medium' | 'low',
      message: f.claim,
    }));
    last.concerns = [...(last.concerns ?? []), ...newConcerns];
    return;
  }

  // Reviewer result: free-text concerns array (no severity per item).
  // Default to 'medium' so the wire's findingsBySeverity bucketing isn't
  // skewed toward 'critical' by accident.
  const reviewerConcerns = (result as ReviewerCallResult).concerns;
  if (Array.isArray(reviewerConcerns) && reviewerConcerns.length > 0) {
    const newConcerns = reviewerConcerns.map(text => ({
      source: 'quality_review' as const,
      severity: 'medium' as const,
      message: text,
    }));
    last.concerns = [...(last.concerns ?? []), ...newConcerns];
  }
}

function makeQualityReworkHandler(reworkIndex: 1 | 2) {
  // rework_1 → attemptIndex 1 (quality index 0 has impl: null and would throw)
  // rework_2 → attemptIndex 2
  const attemptIndex = reworkIndex === 1 ? 1 : 2;
  return async function qualityReworkHandler(state: LifecycleState): Promise<void> {
    const ctx = state.executionContext;
    if (!ctx) return;
    const newResult = await runQualityRework(state, ctx, attemptIndex);
    if (!newResult) {
      // The rework's implementer call did not return an ok RunResult.
      // Mark the chain failed so the next round's `!s.terminal` gate stops
      // the cascade and settle_quality_chain records the failure on the
      // wire envelope. See spec-chain-handlers for the same fix shape.
      state.qualityReworkFailed = true;
      state.terminal = true;
      if (ctx.verbose && typeof ctx.verboseStream === 'function') {
        ctx.verboseStream(
          `[mmagent verbose] event=quality_rework_failed ts=${new Date().toISOString()} batch_id=${ctx.batchId ?? ''} task_index=${ctx.taskIndex ?? 0} rework_index=${reworkIndex}\n`,
        );
      }
      return;
    }
    // Tool sweep #6: same fix as spec-chain — union file-tracker arrays
    // across rework rounds so the envelope reflects ALL writes, not
    // just the most recent attempt's writes.
    replaceLastRunResultPreservingTrackers(state, newResult);
    // Record rework cost. Quality rework_2 (attemptIndex 2) escalates impl
    // from base tier to the other tier; rework_1 stays on base.
    const baseTier: AgentType = ctx.assignedTier;
    const reworkTier: AgentType = (attemptIndex === 2 && baseTier === 'standard') ? 'complex' : baseTier;
    const reworkProvider = ctx.providers[reworkTier];
    mergeStageStats(state, 'quality_rework', {
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

export const qualityReviewRound1Handler = makeQualityReviewHandler(1);
export const qualityReviewRound2Handler = makeQualityReviewHandler(2);
export const qualityReviewRound3Handler = makeQualityReviewHandler(3);
export const qualityReworkRound1Handler = makeQualityReworkHandler(1);
export const qualityReworkRound2Handler = makeQualityReworkHandler(2);

/**
 * Settle handler. Reads the three round verdicts and writes
 * state.qualityChainPassed.
 *
 * Cascade rule:
 *   - 'approved' or 'annotated' in any round ⇒ chain passed (true)
 *   - 'skipped' (e.g., no files written) treated as passed (true) — the
 *     no-block path when there's nothing to review
 *   - 'changes_required' through round 3 ⇒ chain failed (false)
 *   - 'error' in any round ⇒ chain failed (false), state.terminal = true
 *
 * Runs runOnTerminal so the chain-pass slot is authoritative even on
 * hard-fail paths. Idempotent on state.qualityChainPassed.
 */
export function settleQualityChainHandler(state: LifecycleState): void {
  if (typeof state.qualityChainPassed === 'boolean') return;
  const v1 = state.qualityReviewRound1Verdict;
  const v2 = state.qualityReviewRound2Verdict;
  const v3 = state.qualityReviewRound3Verdict;

  if (v1 === undefined && v2 === undefined && v3 === undefined) return;

  const passy = (v: typeof v1): boolean => v === 'approved' || v === 'annotated' || v === 'skipped';
  if (passy(v1) || passy(v2) || passy(v3)) {
    state.qualityChainPassed = true;
    return;
  }
  if (v1 === 'error' || v2 === 'error' || v3 === 'error') {
    // 4.0.3+ soft-success path for read-only routes (audit / review /
    // verify / debug / investigate). These routes have NO rework loop —
    // the annotator is single-pass. When the annotator returns 'error'
    // (typically a parse failure on its own JSON block) BUT the
    // implementer produced a non-empty narrative output, the findings
    // are still recoverable from `lastRunResult.output` in the canonical
    // `## Finding N:` format. Treat that as chain-passed so the wire
    // envelope reports terminal_status='ok' / worker_status='done'
    // instead of leaking 'review_loop_capped' (artifact-producing-route
    // terminology). Round-1 verdict='error' stays in stage stats as a
    // soft telemetry signal. Headline composers + envelope builders
    // fall back to narrative parsing for the findings count.
    const last = state.lastRunResult as { output?: string } | undefined;
    const isReadOnly = state.toolCategory === 'read_only';
    const implementerProducedOutput =
      typeof last?.output === 'string' && last.output.trim().length > 0;
    if (isReadOnly && implementerProducedOutput) {
      state.qualityChainPassed = true;
      return;
    }
    // Artifact-producing route, OR read-only with empty implementer
    // output: hard-fail (no findings to recover).
    state.qualityChainPassed = false;
    state.terminal = true;
    return;
  }
  state.qualityChainPassed = false;
}
