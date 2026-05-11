import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import { specLintTemplate } from '../../review/templates/spec-review.js';
import { qualityLintTemplate } from '../../review/templates/quality-review.js';
import { parseReviewReport } from '../../review/parse-review-report.js';
import { mergeStageStats } from '../merge-stage-stats.js';

interface SubReview {
  source: 'spec' | 'quality';
  text: string;
}

async function runOneReviewer(
  state: LifecycleState,
  ctx: ExecutionContext,
  task: TaskSpec,
  source: 'spec' | 'quality',
  diff: string,
  workerOutput: string,
): Promise<RunResult | { transportError: string }> {
  const template = source === 'spec' ? specLintTemplate : qualityLintTemplate;
  const reviewerTier: AgentType = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
  const provider = ctx.providers[reviewerTier] as Provider | undefined;
  if (!provider) {
    return { transportError: `no provider available for tier ${reviewerTier}` };
  }

  const promptCtx = {
    brief: task.prompt ?? '',
    workerOutput,
    diff,
    planContext: (task as { planContext?: string }).planContext,
  };
  const fullPrompt =
    template.systemPrompt + '\n\n' + template.buildUserPrompt(promptCtx);

  try {
    return await delegateWithEscalation(
      {
        prompt: fullPrompt,
        cwd: ctx.cwd,
        agentType: reviewerTier,
        briefQualityPolicy: 'off',
        timeoutMs: ctx.timing.timeoutMs,
        tools: 'readonly',
      },
      [provider],
      {
        explicitlyPinned: true,
        taskDeadlineMs: ctx.timing.deadlineMs,
        abortSignal: ctx.stall.controller.signal,
        assignedTier: reviewerTier,
        ...(ctx.bus && { bus: ctx.bus }),
        ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
        ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
        stageLabel: 'Review',
      },
    );
  } catch (err) {
    return { transportError: err instanceof Error ? err.message : String(err) };
  }
}

export async function reviewHandler(state: LifecycleState): Promise<void> {
  if (state.terminal) return;
  if (state.reviewVerdict !== undefined) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RunResult | undefined;
  if (!ctx || !task || !last) return;

  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); }
    catch { cumulativeDiff = ''; }
  }
  const workerOutput = last.output ?? '';

  const runSpec = state.reviewPolicy === 'full';
  const runQuality = state.reviewPolicy === 'full'
    || state.reviewPolicy === 'quality_only'
    || state.reviewPolicy === 'diff_only';
  if (!runSpec && !runQuality) {
    state.reviewVerdict = 'approved';
    state.reviewFindings = [];
    return;
  }

  type ReviewOutcome = { source: 'spec' | 'quality'; result: RunResult | { transportError: string } };
  const sources: Array<'spec' | 'quality'> = [];
  if (runSpec) sources.push('spec');
  if (runQuality) sources.push('quality');

  const isOk = (r: RunResult | { transportError: string }): r is RunResult =>
    !('transportError' in r) && r.status === 'ok';

  const settled: ReviewOutcome[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      result: await runOneReviewer(state, ctx, task, source, cumulativeDiff, workerOutput),
    })),
  );
  const retryNeeded = settled
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !isOk(o.result))
    .map(({ i }) => i);
  if (retryNeeded.length > 0) {
    const retried = await Promise.all(
      retryNeeded.map(async (i) => ({
        source: settled[i].source,
        result: await runOneReviewer(state, ctx, task, settled[i].source, cumulativeDiff, workerOutput),
      })),
    );
    retried.forEach((o, k) => { settled[retryNeeded[k]] = o; });
  }

  const findings: SubReview[] = [];
  const errors: string[] = [];
  let anyChangesRequired = false;
  let anySuccess = false;
  for (const { source, result } of settled) {
    if ('transportError' in result) {
      if (source === 'spec') state.specReviewError = result.transportError;
      else state.qualityReviewError = result.transportError;
      errors.push(`${source}: ${result.transportError}`);
      process.stderr.write(`[review-handler] ${source} transportError: ${result.transportError}\n`);
      continue;
    }
    if (result.status !== 'ok') {
      const errDetail = (result as { error?: string }).error ?? '(no error field)';
      const msg = `reviewer status=${result.status}; error=${errDetail}`;
      if (source === 'spec') state.specReviewError = msg;
      else state.qualityReviewError = msg;
      errors.push(`${source}: ${msg}`);
      process.stderr.write(`[review-handler] ${source} ${msg}\n`);
      continue;
    }
    anySuccess = true;
    const parsed = parseReviewReport(result.output ?? '');
    if (source === 'spec') {
      state.specReviewerNotes = result.output;
      state.specReviewVerdict = parsed.verdict;
    } else {
      state.qualityReviewerNotes = result.output;
      state.qualityReviewVerdict = parsed.verdict;
    }
    if (parsed.verdict === 'changes_required') anyChangesRequired = true;
    for (const dev of parsed.deviations) {
      findings.push({ source, text: dev });
    }
  }

  state.reviewFindings = findings;
  if (!anySuccess) {
    state.reviewVerdict = 'changes_required';
    state.reviewError = errors.join(' | ');
    return;
  }
  state.reviewVerdict = anyChangesRequired ? 'changes_required' : 'approved';

  let combinedInput = 0, combinedOutput = 0, combinedCached = 0, combinedNonRead = 0;
  let combinedTurns = 0, combinedTools = 0;
  let combinedCost: number | null = null;
  let combinedDuration = 0;
  for (const { result } of settled) {
    if ('transportError' in result || result.status !== 'ok') continue;
    combinedInput  += result.usage?.inputTokens ?? 0;
    combinedOutput += result.usage?.outputTokens ?? 0;
    combinedCached += result.usage?.cachedReadTokens ?? 0;
    combinedNonRead += result.usage?.cachedNonReadTokens ?? 0;
    combinedTurns  += result.turns ?? 1;
    combinedTools  += Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
    combinedDuration = Math.max(combinedDuration, result.durationMs ?? 0);
    const c = (result as { costUSD?: number | null }).costUSD;
    if (c !== null && c !== undefined) combinedCost = (combinedCost ?? 0) + c;
  }
  const reviewerTier = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
  mergeStageStats(state, 'review', {
    inputTokens: combinedInput,
    outputTokens: combinedOutput,
    cachedReadTokens: combinedCached,
    cachedNonReadTokens: combinedNonRead,
    turnCount: combinedTurns,
    toolCallCount: combinedTools,
    costUSD: combinedCost,
    durationMs: combinedDuration || null,
  }, {
    tier: reviewerTier,
    model: (ctx.providers[reviewerTier]?.config as { model?: string } | undefined)?.model ?? null,
    verdict: state.reviewVerdict,
  });
}
