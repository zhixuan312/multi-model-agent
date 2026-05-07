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

  let diff = '';
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
      return engine.runDiff(shell, {
        workerOutput: diff,
        brief: `verification: ${verifyResult.status}\n${verifyResult.steps.map(s => `- ${s.command} → ${s.status}`).join('\n')}`,
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
}
