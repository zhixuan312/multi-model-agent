// v4.4.x — Review stage.
//
// One complex session, two sequential turns: spec review, then quality
// review. Same session = same cached prefix on the 2nd turn. Combined
// verdict is `approved` only if BOTH reviewers approve; otherwise
// `changes_required`. Combined `reviewConcerns` is the concat of both
// reviewers' concerns.

import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { AgentType, TaskSpec } from '../../types.js';
import { specLintTemplate } from '../../review/templates/spec-review.js';
import { qualityLintTemplate } from '../../review/templates/quality-review.js';
import { parseReviewReport } from '../../review/parse-review-report.js';
import { mergeStageStats } from '../merge-stage-stats.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import { buildWarmFollowupMessage } from '../warm-followup.js';
import type { Session, TurnResult } from '../../types/run-result.js';

interface SubReview { source: 'spec' | 'quality'; text: string }

async function runOneReviewer(
  session: Session,
  task: TaskSpec,
  source: 'spec' | 'quality',
  diff: string,
  workerOutput: string,
  isWarmFollowup: boolean,
): Promise<{ turn: TurnResult } | { transportError: string }> {
  const template = source === 'spec' ? specLintTemplate : qualityLintTemplate;
  const promptCtx = {
    brief: task.prompt ?? '',
    workerOutput,
    diff,
    planContext: (task as { planContext?: string }).planContext,
  };
  // Warm follow-up: the same reviewer session already loaded brief +
  // diff + planContext on turn 1. Send only the new instruction via
  // the standard preamble. systemPrompt is intentionally not
  // re-prepended — it lives in the resumed session's history.
  // Cold open: full system prompt + brief + diff + planContext.
  const fullPrompt = isWarmFollowup && template.buildWarmFollowup
    ? buildWarmFollowupMessage(template.buildWarmFollowup(promptCtx))
    : template.systemPrompt + '\n\n' + template.buildUserPrompt(promptCtx);
  try {
    const turn = await session.send(fullPrompt, { stageLabel: HUMAN_LABEL.review });
    return { turn };
  } catch (err) {
    return { transportError: err instanceof Error ? err.message : String(err) };
  }
}

export async function reviewHandler(state: LifecycleState): Promise<void> {
  if (state.terminal) return;
  if (state.reviewVerdict !== undefined) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as { output?: string } | undefined;
  if (!ctx || !task || !last) return;

  if (state.reviewPolicy === 'none') {
    state.reviewVerdict = 'approved';
    state.reviewFindings = [];
    return;
  }

  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); } catch { /* tolerated */ }
  }
  const workerOutput = last.output ?? '';

  // v4.4.x: spec and quality run sequentially on the SAME complex
  // session so the second call benefits from the cached prefix.
  const reviewerTier: AgentType = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
  if (!ctx.providers[reviewerTier]) {
    state.reviewVerdict = 'changes_required';
    state.reviewError = `no provider available for tier ${reviewerTier}`;
    state.reviewFindings = [];
    return;
  }
  // Which sub-reviews to run, per reviewPolicy.
  const runSpec = state.reviewPolicy === 'full';
  const runQuality = state.reviewPolicy === 'full'
    || state.reviewPolicy === 'quality_only'
    || state.reviewPolicy === 'diff_only';
  const sources: Array<'spec' | 'quality'> = [];
  if (runSpec) sources.push('spec');
  if (runQuality) sources.push('quality');
  if (sources.length === 0) {
    state.reviewVerdict = 'approved';
    state.reviewFindings = [];
    return;
  }

  const findings: SubReview[] = [];
  const errors: string[] = [];
  let anyChangesRequired = false;
  let anySuccess = false;

  // Sequential — second turn hits the cached prefix on the same session.
  // The warm-follow-up form is valid ONLY when iteration > 0 AND the
  // session reference is the same as iteration 0. Today ctx.getSession
  // is idempotent on tier so both iterations see the same session; the
  // identity guard exists so a future change that rotates the reviewer
  // session mid-stage (escalation rotation, retry-after-failure) falls
  // back to cold-open automatically rather than sending a warm follow-up
  // into a fresh thread that lacks the prior history.
  const settled: Array<{ source: 'spec' | 'quality'; outcome: { turn: TurnResult } | { transportError: string } }> = [];
  let firstSession: Session | null = null;
  for (let iteration = 0; iteration < sources.length; iteration++) {
    const source = sources[iteration]!;
    const currentSession = ctx.getSession(reviewerTier);
    if (iteration === 0) firstSession = currentSession;
    const isWarmFollowup = iteration > 0 && currentSession === firstSession;
    const outcome = await runOneReviewer(
      currentSession,
      task,
      source,
      cumulativeDiff,
      workerOutput,
      isWarmFollowup,
    );
    settled.push({ source, outcome });
  }

  let combinedInput = 0, combinedOutput = 0, combinedCached = 0, combinedNonRead = 0;
  let combinedTurns = 0;
  let combinedCost: number | null = null;
  let combinedDuration = 0;

  for (const { source, outcome } of settled) {
    if ('transportError' in outcome) {
      if (source === 'spec') state.specReviewError = outcome.transportError;
      else state.qualityReviewError = outcome.transportError;
      errors.push(`${source}: ${outcome.transportError}`);
      process.stderr.write(`[review-handler] ${source} transportError: ${outcome.transportError}\n`);
      continue;
    }
    anySuccess = true;
    const parsed = parseReviewReport(outcome.turn.output ?? '');
    if (source === 'spec') {
      state.specReviewerNotes = outcome.turn.output;
      state.specReviewVerdict = parsed.verdict;
    } else {
      state.qualityReviewerNotes = outcome.turn.output;
      state.qualityReviewVerdict = parsed.verdict;
    }
    if (parsed.verdict === 'changes_required') anyChangesRequired = true;
    for (const dev of parsed.deviations) findings.push({ source, text: dev });

    combinedInput += outcome.turn.usage?.inputTokens ?? 0;
    combinedOutput += outcome.turn.usage?.outputTokens ?? 0;
    combinedCached += outcome.turn.usage?.cachedReadTokens ?? 0;
    combinedNonRead += outcome.turn.usage?.cachedNonReadTokens ?? 0;
    combinedTurns += outcome.turn.turns ?? 1;
    combinedDuration += outcome.turn.durationMs ?? 0;
    const c = outcome.turn.costUSD;
    if (c !== null && c !== undefined) combinedCost = (combinedCost ?? 0) + c;
  }

  state.reviewFindings = findings;
  (state as { reviewConcerns?: string[] }).reviewConcerns = findings.map((f) => f.text);

  if (!anySuccess) {
    state.reviewVerdict = 'changes_required';
    state.reviewError = errors.join(' | ');
    return;
  }
  state.reviewVerdict = anyChangesRequired ? 'changes_required' : 'approved';

  mergeStageStats(state, 'review', {
    inputTokens: combinedInput,
    outputTokens: combinedOutput,
    cachedReadTokens: combinedCached,
    cachedNonReadTokens: combinedNonRead,
    turnCount: combinedTurns,
    toolCallCount: 0,
    costUSD: combinedCost,
    durationMs: combinedDuration || null,
  }, {
    tier: reviewerTier,
    model: (ctx.providers[reviewerTier]?.config as { model?: string } | undefined)?.model ?? null,
    verdict: state.reviewVerdict,
  });
}
