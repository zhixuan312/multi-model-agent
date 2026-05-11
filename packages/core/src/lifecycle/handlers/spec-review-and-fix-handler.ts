// Stage 2 handler — spec-review-and-fix (pipeline-redesign §3.2.1).
// Invokes complex tier with full tools; the reviewer fixes gaps directly.
// Provider errors record in state.specReviewError and do NOT terminate.
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, RunResult, AgentType, TaskSpec } from '../../types.js';
import { delegateWithEscalation } from '../../escalation/delegate-with-escalation.js';
import { replaceLastRunResultPreservingTrackers } from '../merge-stage-stats.js';
import { specReviewAndFixTemplate } from '../../review/templates/spec-review-and-fix.js';

export async function specReviewAndFixHandler(state: LifecycleState): Promise<void> {
  if (state.reviewPolicy !== 'full') return;
  if (state.terminal) return;
  // Idempotency
  if (state.specReviewerNotes !== undefined || state.specReviewError !== undefined) return;

  const ctx = state.executionContext as ExecutionContext | undefined;
  const task = state.task as TaskSpec | undefined;
  const last = state.lastRunResult as RunResult | undefined;
  if (!ctx || !task || !last) return;

  // Build prompt context
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
  };
  const reviewerTier: AgentType = ctx.assignedTier === 'standard' ? 'complex' : 'standard';
  const provider = ctx.providers[reviewerTier] as Provider | undefined;
  if (!provider) {
    state.specReviewError = `no provider available for tier ${reviewerTier}`;
    return;
  }

  const fullPrompt =
    specReviewAndFixTemplate.systemPrompt + '\n\n' +
    specReviewAndFixTemplate.buildUserPrompt(promptCtx);

  let result: RunResult;
  try {
    result = await delegateWithEscalation(
      {
        prompt: fullPrompt,
        cwd: ctx.cwd,
        agentType: reviewerTier,
        briefQualityPolicy: 'off',
        timeoutMs: ctx.timing.timeoutMs,
        // Pipeline-redesign §3.2.1: reviewer has FULL editor tools so it
        // can fix gaps inline. Without this, the reviewer is read-only and
        // can only diagnose (which is what the OLD reviewer did — exactly
        // the failure mode this redesign was meant to fix).
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
        stageLabel: 'Spec review + fix',
      },
    );
  } catch (err) {
    state.specReviewError = err instanceof Error ? err.message : String(err);
    return;
  }

  if (result.status !== 'ok') {
    state.specReviewError = `reviewer returned status: ${result.status}`;
    return;
  }
  state.specReviewerNotes = result.output;
  replaceLastRunResultPreservingTrackers(state, result);
}
