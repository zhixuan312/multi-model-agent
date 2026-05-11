// Stage 3 handler — quality-review-and-fix (pipeline-redesign §3.2.2).
// Mirrors specReviewAndFixHandler but with quality lens and different gates.
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import { replaceLastRunResultPreservingTrackers } from '../merge-stage-stats.js';
import { qualityReviewAndFixTemplate } from '../../review/templates/quality-review-and-fix.js';

export async function qualityReviewAndFixHandler(state: LifecycleState): Promise<void> {
  if (state.reviewPolicy !== 'full' && state.reviewPolicy !== 'quality_only') return;
  if (state.terminal) return;
  if (state.qualityReviewerNotes !== undefined || state.qualityReviewError !== undefined) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RunResult | undefined;
  if (!ctx || !task || !last) return;

  let cumulativeDiff = '';
  if (state.diffTracker) {
    try { cumulativeDiff = await state.diffTracker.cumulativeDiff(); }
    catch { cumulativeDiff = ''; }
  }
  const promptCtx = {
    brief: task.prompt ?? '',
    workerOutput: last.output ?? '',
    diff: cumulativeDiff,
    planContext: (task as { planContext?: string }).planContext,
    priorConcerns: state.specReviewerNotes ? [state.specReviewerNotes] : [],
  };
  const reviewerTier: AgentType = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
  const provider = ctx.providers[reviewerTier] as Provider | undefined;
  if (!provider) {
    state.qualityReviewError = `no provider available for tier ${reviewerTier}`;
    return;
  }

  const fullPrompt =
    qualityReviewAndFixTemplate.systemPrompt + '\n\n' +
    qualityReviewAndFixTemplate.buildUserPrompt(promptCtx);

  let result: RunResult;
  try {
    result = await delegateWithEscalation(
      {
        prompt: fullPrompt,
        cwd: ctx.cwd,
        agentType: reviewerTier,
        briefQualityPolicy: 'off',
        timeoutMs: ctx.timing.timeoutMs,
        // Pipeline-redesign §3.2.2: full editor tools (same as spec stage).
        tools: 'full',
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
        stageLabel: 'Quality review + fix',
      },
    );
  } catch (err) {
    state.qualityReviewError = err instanceof Error ? err.message : String(err);
    return;
  }

  if (result.status !== 'ok') {
    state.qualityReviewError = `reviewer returned status: ${result.status}`;
    return;
  }
  state.qualityReviewerNotes = result.output;
  replaceLastRunResultPreservingTrackers(state, result);
}
