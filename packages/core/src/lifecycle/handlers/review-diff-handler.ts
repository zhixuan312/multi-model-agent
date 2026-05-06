import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { Provider, AgentType, RunResult } from '../../types.js';
import { runDiffReview, type DiffReviewVerdict, type DiffReviewOrSkipped } from '../../review/diff-review.js';
import { pickReviewer } from '../../escalation/policy.js';
import {
  runWithFallback,
  isReviewTransportFailure,
  type UnavailableMap,
} from '../../escalation/fallback.js';
import { makeSkippedReviewResult } from '../../review/skipped-result.js';
import type { VerifyStageResult } from './verify-stage.js';

const exec = promisify(execFile);

/**
 * StageHandler for row 4.13 (review_diff).
 *
 * Reads from state:
 *   - state.task / state.executionContext for cwd, providers, timing
 *   - state.verifyResult: VerifyStageResult required by runDiffReview
 *   - state.diffReviewVerdict: idempotency guard
 *
 * Writes to state:
 *   - state.diffReviewKind: raw kind from runDiffReview
 *   - state.diffReviewVerdict: envelope-mapped status
 *   - state.terminal = true on 'changes_required' (reject) or 'error'
 *
 * Verdict mapping (preserved from reviewed-lifecycle.ts:1361):
 *   kind: 'approve'           → envelope 'approved'
 *   kind: 'concerns'          → envelope 'approved' (counter-intuitive but
 *                                matches existing behavior — concerns flagged
 *                                but not blocking)
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
  let diffTruncated = false;
  try {
    const { stdout } = await exec('git', ['diff', 'HEAD~..HEAD'], { cwd: ctx.cwd });
    const cap = 64 * 1024;
    const bytes = Buffer.byteLength(stdout, 'utf8');
    diffTruncated = bytes > cap;
    diff = diffTruncated
      ? Buffer.from(stdout, 'utf8').subarray(0, cap).toString('utf8') + '\n[diff truncated]'
      : stdout;
  } catch {
    state.diffReviewVerdict = 'error';
    state.terminal = true;
    return;
  }

  state.diffUnavailable ??= new Map() as UnavailableMap;
  const diffUnavailable: UnavailableMap = state.diffUnavailable;

  const diffCall = await runWithFallback<DiffReviewOrSkipped>({
    assigned: reviewerTier,
    providerFor: (tier: AgentType) => ctx.providers[tier] as Provider | undefined,
    unavailableTiers: diffUnavailable,
    isTransportFailure: (r) => isReviewTransportFailure(r),
    getStatus: (r) => (r as { status?: RunResult['status'] }).status,
    makeSyntheticFailure: () => makeSkippedReviewResult('all_tiers_unavailable'),
    forbiddenTiers: [baseTier],
    call: (provider) =>
      runDiffReview({
        cwd: ctx.cwd,
        diff,
        diffTruncated,
        verification: verifyResult,
        worker: {
          call: (prompt, opts) =>
            provider.run(prompt, {
              cwd: opts?.cwd ?? ctx.cwd,
              abortSignal: opts?.abortSignal,
              timeoutMs: opts?.timeoutMs,
            }),
        },
        taskDeadlineMs: ctx.timing.deadlineMs,
        abortSignal: ctx.stall.controller.signal,
      }),
  });

  if (diffCall.bothUnavailable) {
    state.diffReviewVerdict = 'skipped';
    return;
  }
  const verdictOrSkipped = diffCall.result;
  if (!('kind' in verdictOrSkipped)) {
    state.diffReviewVerdict = 'skipped';
    return;
  }
  const verdict: DiffReviewVerdict = verdictOrSkipped;

  state.diffReviewKind = verdict.kind;
  if (verdict.kind === 'approve' || verdict.kind === 'concerns') {
    state.diffReviewVerdict = 'approved';
  } else if (verdict.kind === 'reject') {
    state.diffReviewVerdict = 'changes_required';
    state.terminal = true;
  } else {
    state.diffReviewVerdict = 'error';
    state.terminal = true;
  }
}
