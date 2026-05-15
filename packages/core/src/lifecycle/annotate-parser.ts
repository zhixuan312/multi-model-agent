// packages/core/src/lifecycle/annotate-parser.ts
//
// Deterministic precondition enforcer for the annotate stage.
// The LLM annotator may propose `completed: true`; this parser enforces
// the rules in spec §5.7.1 and may override to `false` with a synthesized
// recovery-suggesting message.

import type { AnnotatePayload, RouteName } from './stage-io.js';
import type { LifecycleState } from './stage-plan-types.js';

const READ_ROUTES: ReadonlyArray<string> =
  ['audit', 'review', 'debug', 'investigate', 'explore'];

/**
 * Apply spec §5.7.1 preconditions to a proposed AnnotatePayload.
 * If any precondition fails, return a forced `completed: false` payload
 * with a synthesized message naming what blocked.
 */
export function applyAnnotatePreconditions(
  proposed: AnnotatePayload,
  state: LifecycleState,
): AnnotatePayload {
  const route = (state.route as RouteName | undefined) ?? 'delegate';
  const isRead = READ_ROUTES.includes(route);
  const reasons: string[] = [];

  const last = (state as any).lastRunResult ?? null;
  const workerSelfAssessment: string | undefined =
    last?.workerStatus ?? (state as any).workerStatus;

  // Implement-advance precondition: applies to all routes.
  if (!last || last.status === 'error') {
    reasons.push('implement did not advance');
  }

  if (isRead) {
    if (workerSelfAssessment !== 'done') {
      reasons.push(`worker self-assessed as ${workerSelfAssessment ?? 'unknown'}`);
    }
    const succ = (last?.criteriaSucceeded?.length ?? last?.findings?.length ?? 0) as number;
    const errs = (last?.criteriaErrors?.length ?? 0) as number;
    // M2 rule: completed iff at least one criterion succeeded, OR no criteria configured.
    if (succ === 0 && errs > 0) {
      reasons.push(`zero of ${succ + errs} criteria succeeded`);
    }
  } else {
    // Write route.
    if (workerSelfAssessment !== 'done') {
      reasons.push(`worker self-assessed as ${workerSelfAssessment ?? 'unknown'}`);
    }
    const reviewVerdict = (state as any).reviewVerdict as string | undefined;
    const reviewPolicy = (state as any).reviewPolicy as string | undefined;
    const reworkApplied = (state as any).reworkApplied as boolean | undefined;
    const reworkError = (state as any).reworkError as string | undefined;
    const unaddressed: string[] = last?.unaddressedFindingIds ?? [];

    const reviewClean =
      reviewPolicy === 'none' ||
      reviewVerdict === 'approved' ||
      (reworkApplied === true && reworkError === undefined && unaddressed.length === 0);
    if (!reviewClean) {
      if (reviewVerdict === 'changes_required' && (reworkApplied !== true || reworkError !== undefined)) {
        reasons.push('review required changes; rework did not advance cleanly');
      } else if (unaddressed.length > 0) {
        reasons.push(`rework left ${unaddressed.length} findings unaddressed: ${unaddressed.slice(0, 5).join(', ')}`);
      } else {
        reasons.push(`review verdict: ${reviewVerdict ?? 'unknown'}`);
      }
    }

    const commits = (state as any).commits;
    const commitsExist = Array.isArray(commits) && commits.length > 0;
    const autoCommit = (state as any).autoCommit;
    const noDiff = last?.commitSkipReason === 'no_diff';
    const hookFailed = last?.commitSkipReason === 'hook_failed';
    const commitClean =
      autoCommit === false || commitsExist || noDiff;
    if (!commitClean) {
      if (hookFailed) reasons.push('commit blocked: pre-commit hook failed');
      else reasons.push('no commit landed and no clean no_op reason');
    }
  }

  if (reasons.length === 0) return proposed;

  // Parser override: force completed=false; synthesize recovery message.
  return {
    ...proposed,
    completed: false,
    message:
      `Task did not complete: ${reasons.join('; ')}. ` +
      (proposed.message && /recover|re-?dispatch|retry|investigate/i.test(proposed.message)
        ? proposed.message
        : 'Recommend re-dispatch with the unresolved finding IDs and adjusted brief.'),
  };
}
