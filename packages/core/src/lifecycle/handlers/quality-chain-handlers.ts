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
  };
}

function makeQualityReworkHandler(reworkIndex: 1 | 2) {
  // rework_1 → attemptIndex 1 (quality index 0 has impl: null and would throw)
  // rework_2 → attemptIndex 2
  const attemptIndex = reworkIndex === 1 ? 1 : 2;
  return async function qualityReworkHandler(state: LifecycleState): Promise<void> {
    const ctx = state.executionContext;
    if (!ctx) return;
    const newResult = await runQualityRework(state, ctx, attemptIndex);
    if (!newResult) return;
    state.lastRunResult = newResult;
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
    state.qualityChainPassed = false;
    state.terminal = true;
    return;
  }
  state.qualityChainPassed = false;
}
