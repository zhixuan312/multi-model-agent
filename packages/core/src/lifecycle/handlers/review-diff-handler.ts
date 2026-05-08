import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, AgentType, RunResult } from '../../types.js';
import type { ReviewerDiffCallResult } from '../../review/reviewer-engine.js';
import { pickReviewer } from '../../escalation/policy.js';
import {
  runWithFallback,
  isReviewTransportFailure,
  type UnavailableMap,
} from '../../escalation/fallback.js';
import { makeSkippedReviewResult, type SkippedReviewResult } from '../../review/skipped-result.js';
import { makeRunnerShell } from '../../providers/make-runner-shell.js';
import type { VerifyStageResult } from './verify-stage.js';
import { mergeStageStats } from '../merge-stage-stats.js';

const exec = promisify(execFile);

/**
 * StageHandler for row 4.13 (review_diff).
 *
 * Reads from state:
 *   - state.task / state.executionContext for cwd, providers, timing
 *   - state.verifyResult: VerifyStageResult required by reviewerEngine.runDiff
 *   - state.diffReviewVerdict: idempotency guard
 *
 * Writes to state:
 *   - state.diffReviewKind: raw verdict from reviewerEngine.runDiff
 *   - state.diffReviewVerdict: envelope-mapped status
 *   - state.terminal = true on 'changes_required' (reject) or 'error'
 *
 * Verdict mapping:
 *   kind: 'approve'           → envelope 'approved'
 *   kind: 'concerns'          → envelope 'approved' (concerns are flagged
 *                                but non-blocking by design)
 *   kind: 'reject'            → envelope 'changes_required'
 *   kind: 'transport_failure' → envelope 'error'
 *
 * Both slots are written so downstream telemetry can distinguish 'approve'
 * from 'concerns' (both map to envelope 'approved').
 *
 * Defensive no-op when state.executionContext, state.verifyResult, or the
 * reviewer provider for the picked tier is missing. Diff is computed via
 * `git diff HEAD~..HEAD` against the cwd; if git fails, the handler
 * records an envelope 'error' and sets terminal.
 */
export async function reviewDiffHandler(state: LifecycleState): Promise<void> {
  if (state.diffReviewVerdict) return;

  const ctx = state.executionContext;
  if (!ctx) return;

  const verifyResult = state.verifyResult as VerifyStageResult | undefined;
  if (!verifyResult) return;

  const baseTier: AgentType = ctx.assignedTier;
  const reviewerTier = pickReviewer({ loop: 'spec', attemptIndex: 0, baseTier });

  // Tool sweep #6: prefer the snapshot-based DiffTracker (works in
  // non-git dirs, captures the cumulative across rework rounds against
  // the pre-task baseline). Fall back to `git diff HEAD~..HEAD` for
  // legacy callers (autoCommit pipelines that ran before the tracker
  // was wired in). If BOTH sources fail, hard-error: reviewing without
  // evidence would be the very bug this sweep is fixing.
  let diff = '';
  let trackerProvided = false;
  if (state.diffTracker) {
    try {
      diff = await state.diffTracker.cumulativeDiff();
      trackerProvided = true;
    } catch {
      // tracker error — fall through to git
    }
  }
  if (!trackerProvided) {
    try {
      const { stdout } = await exec('git', ['diff', 'HEAD~..HEAD'], { cwd: ctx.cwd });
      const cap = 64 * 1024;
      const bytes = Buffer.byteLength(stdout, 'utf8');
      diff = bytes > cap
        ? Buffer.from(stdout, 'utf8').subarray(0, cap).toString('utf8') + '\n[diff truncated]'
        : stdout;
    } catch {
      state.diffReviewVerdict = 'error';
      state.terminal = true;
      return;
    }
  }

  state.diffUnavailable ??= new Map() as UnavailableMap;
  const diffUnavailable: UnavailableMap = state.diffUnavailable;

  const diffCall = await runWithFallback<ReviewerDiffCallResult | SkippedReviewResult>({
    assigned: reviewerTier,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: diffUnavailable,
    isTransportFailure: (r) => isReviewTransportFailure(r as { status?: string }),
    getStatus: (r) => (r as { status?: RunResult['status'] }).status,
    makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
    call: async (provider, usedTier) => {
      const shell = makeRunnerShell(provider);
      const engine = ctx.reviewerEngine;
      if (!engine) throw new Error('reviewerEngine not configured');
      // Tool sweep #6: pass diff via the dedicated `diff` field so the
      // template's "# Cumulative diff" section gets actual diff content
      // instead of conflating it with the worker's text summary.
      // workerOutput stays as the verification summary so the diff
      // reviewer has both signals.
      const lastResult = state.lastRunResult as { output?: string } | undefined;
      const verifySummary = `Verification: ${verifyResult.status}\n${verifyResult.steps.map(s => `- ${s.command} → ${s.status}`).join('\n')}`;
      return engine.runDiff(shell, {
        workerOutput: lastResult?.output ?? verifySummary,
        brief: `verification: ${verifyResult.status}\n${verifyResult.steps.map(s => `- ${s.command} → ${s.status}`).join('\n')}`,
        diff,
        cwd: ctx.cwd,
        abortSignal: ctx.stall.controller.signal,
        deadlineMs: ctx.timing.deadlineMs,
        ...(ctx.bus && { bus: ctx.bus }),
        ...(ctx.batchId !== undefined && { batchId: ctx.batchId }),
            ...(ctx.taskIndex !== undefined && { taskIndex: ctx.taskIndex }),
        tier: usedTier,
        stageLabel: 'Diff review',
      });
    },
  });

  if (diffCall.bothUnavailable) {
    state.diffReviewVerdict = 'skipped';
    return;
  }
  const verdictOrSkipped = diffCall.result;
  if ('status' in verdictOrSkipped && verdictOrSkipped.status === 'skipped') {
    state.diffReviewVerdict = 'skipped';
    return;
  }
  const result = verdictOrSkipped as ReviewerDiffCallResult;

  state.diffReviewKind = result.verdict;
  if (result.verdict === 'approve' || result.verdict === 'concerns') {
    state.diffReviewVerdict = 'approved';
  } else if (result.verdict === 'reject') {
    state.diffReviewVerdict = 'changes_required';
    state.terminal = true;
  } else {
    state.diffReviewVerdict = 'error';
    state.terminal = true;
  }
  // Persist diff-reviewer concerns into lastRunResult.concerns so the
  // wire's findings_* DB columns reflect them on diff_review verdicts
  // other than 'approve'. Without this, findings counts stay 0 even when
  // the diff reviewer rejected with explicit concerns.
  if (Array.isArray(result.concerns) && result.concerns.length > 0) {
    const last = state.lastRunResult as RunResult | undefined;
    if (last) {
      const newConcerns = result.concerns.map(text => ({
        source: 'diff_review' as const,
        severity: 'medium' as const,
        message: text,
      }));
      last.concerns = [...(last.concerns ?? []), ...newConcerns];
    }
  }
  // Record diff_review cost so wire telemetry sees it.
  const reviewerProvider = ctx.providers[reviewerTier];
  mergeStageStats(state, 'diff_review', {
    inputTokens: result.cost?.inputTokens ?? 0,
    outputTokens: result.cost?.outputTokens ?? 0,
    turnCount: result.cost?.turnCount ?? 0,
    toolCallCount: result.cost?.toolCallCount ?? 0,
    costUSD: result.cost?.costUSD ?? null,
    durationMs: result.cost?.durationMs ?? null,
  }, {
    tier: reviewerTier,
    model: (reviewerProvider?.config as { model?: string } | undefined)?.model ?? null,
    verdict: state.diffReviewVerdict,
  });
}
