import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { pickReviewer, pickEscalation } from '../../escalation/policy.js';
import { runSpecReview, type SpecReviewResult } from '../../review/spec-reviewer.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';

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
 * Idempotency: each handler skips when its verdict slot is already populated
 * (legacy executor path during the cutover transition).
 *
 * Defensive no-ops: when state.task, state.executionContext, or
 * state.lastRunResult is missing, the handler short-circuits. The legacy
 * executor still owns the spec chain in production until Step 5 lands the
 * per-task data flow.
 */

interface ReviewRoundInput {
  state: LifecycleState;
  ctx: ExecutionContext;
  round: 1 | 2 | 3;
}

async function runSpecReviewRound(input: ReviewRoundInput): Promise<SpecReviewResult | null> {
  const { state, ctx, round } = input;
  const last = state.lastRunResult as RunResult | undefined;
  if (!last) return null;
  const implReport = last.implementationReport ?? last.structuredReport;
  if (!implReport) return null;

  const baseTier: AgentType = ctx.assignedTier;
  const reviewerTier = pickReviewer({ loop: 'spec', attemptIndex: round - 1, baseTier });
  const reviewerProvider = ctx.providers[reviewerTier] as Provider | undefined;
  if (!reviewerProvider) return null;

  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  const packet = {
    prompt: task.prompt ?? '',
    scope: task.filePaths ?? [],
    doneCondition: task.done ?? '',
  };
  const fileContents: Record<string, string> = {};
  const toolCallLog: string[] = last.toolCalls ?? [];

  return runSpecReview(
    reviewerProvider,
    packet,
    implReport,
    fileContents,
    toolCallLog,
    task.planContext,
    undefined,
    ctx.timing.deadlineMs,
    ctx.stall.controller.signal,
    undefined,
    ctx.cwd,
  );
}

async function runSpecRework(input: ReviewRoundInput): Promise<RunResult | null> {
  const { state, ctx, round } = input;
  const task = state.task as TaskSpec | undefined;
  if (!task) return null;

  const attemptIndex = round; // rework_1 → attemptIndex 1, rework_2 → attemptIndex 2
  const baseTier: AgentType = ctx.assignedTier;
  const decision = pickEscalation({ loop: 'spec', attemptIndex, baseTier });
  const provider = ctx.providers[decision.impl] as Provider | undefined;
  if (!provider) return null;

  state.specChainAttemptIndex = attemptIndex;

  const reworkPrompt = (task.prompt ?? '') + '\n\n[spec rework — address the prior reviewer feedback]';
  const reworkTask: TaskSpec = { ...task, prompt: reworkPrompt };
  const result = await delegateWithEscalation(
    {
      prompt: reworkTask.prompt,
      cwd: ctx.cwd,
      agentType: decision.impl,
      briefQualityPolicy: 'off',
      timeoutMs: ctx.timing.timeoutMs,
    },
    [provider],
    {
      explicitlyPinned: true,
      taskDeadlineMs: ctx.timing.deadlineMs,
      abortSignal: ctx.stall.controller.signal,
    },
  );
  if (result.status !== 'ok') return null;
  return result as unknown as RunResult;
}

function makeSpecReviewHandler(round: 1 | 2 | 3) {
  const slot = `specReviewRound${round}Verdict` as const;
  return async function specReviewRoundHandler(state: LifecycleState): Promise<void> {
    if (state[slot]) return; // idempotency
    const ctx = state.executionContext;
    if (!ctx) return; // defensive no-op
    const result = await runSpecReviewRound({ state, ctx, round });
    if (!result) return;
    if (result.status === 'approved') {
      state[slot] = 'approved';
    } else if (result.status === 'changes_required') {
      state[slot] = 'changes_required';
    } else {
      state[slot] = 'error';
    }
  };
}

function makeSpecReworkHandler(round: 1 | 2) {
  return async function specReworkHandler(state: LifecycleState): Promise<void> {
    const ctx = state.executionContext;
    if (!ctx) return;
    const newResult = await runSpecRework({ state, ctx, round: (round + 1) as 2 | 3 });
    if (!newResult) return;
    state.lastRunResult = newResult;
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
 * hard-fail paths. Idempotent: skips when state.specChainPassed is already
 * populated by an upstream handler (legacy executor).
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
