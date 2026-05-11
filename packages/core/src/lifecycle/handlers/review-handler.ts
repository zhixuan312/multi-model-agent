import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import { specLintTemplate } from '../../review/templates/spec-review.js';
import { qualityLintTemplate } from '../../review/templates/quality-review.js';
import { parseReviewReport } from '../../review/parse-review-report.js';

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

  const promises: Array<Promise<{ source: 'spec' | 'quality'; result: RunResult | { transportError: string } }>> = [];
  if (runSpec) {
    promises.push(runOneReviewer(state, ctx, task, 'spec', cumulativeDiff, workerOutput)
      .then((r) => ({ source: 'spec' as const, result: r })));
  }
  if (runQuality) {
    promises.push(runOneReviewer(state, ctx, task, 'quality', cumulativeDiff, workerOutput)
      .then((r) => ({ source: 'quality' as const, result: r })));
  }
  const settled = await Promise.all(promises);

  const findings: SubReview[] = [];
  const errors: string[] = [];
  let anyChangesRequired = false;
  let anySuccess = false;
  for (const { source, result } of settled) {
    if ('transportError' in result) {
      if (source === 'spec') state.specReviewError = result.transportError;
      else state.qualityReviewError = result.transportError;
      errors.push(`${source}: ${result.transportError}`);
      continue;
    }
    if (result.status !== 'ok') {
      const msg = `reviewer returned status: ${result.status}`;
      if (source === 'spec') state.specReviewError = msg;
      else state.qualityReviewError = msg;
      errors.push(`${source}: ${msg}`);
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
}
