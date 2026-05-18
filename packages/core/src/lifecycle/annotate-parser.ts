// packages/core/src/lifecycle/annotate-parser.ts
//
// Deterministic precondition enforcer for the annotate stage.
// The LLM annotator may propose `completed: true`; this parser delegates
// the completion decision to deriveCompletion() (single source of truth)
// and synthesizes a gate-naming recovery-suggesting message when blocking.

import type { AnnotatePayload } from './stage-io.js';
import type { LifecycleState } from './stage-plan-types.js';
import { deriveCompletion, extractCompletionInputs } from './derive-completion.js';

/**
 * Apply spec §5.7.1 preconditions to a proposed AnnotatePayload.
 * If deriveCompletion() returns completed=false, return a forced
 * `completed: false` payload with a synthesized recovery message
 * naming the blocking gate (review verdict, unaddressed finding IDs,
 * commit gate, or criteria) plus a recovery suggestion.
 */
export function applyAnnotatePreconditions(
  proposed: AnnotatePayload,
  state: LifecycleState,
): AnnotatePayload {
  const inputs = extractCompletionInputs(state);
  const { completed } = deriveCompletion(inputs);

  if (completed) return { ...proposed, completed: true };

  // Synthesize a specific, gate-naming message. Read concrete details
  // from state for richer wording than deriveCompletion's generic reasons.
  const last = (state as { lastRunResult?: { unaddressedFindingIds?: string[]; criteriaSucceeded?: string[]; criteriaErrors?: unknown[] } }).lastRunResult ?? null;
  const READ_ROUTES = new Set(['audit', 'review', 'debug', 'investigate', 'explore', 'research']);
  const isRead = READ_ROUTES.has(inputs.route as string);

  const reasons: string[] = [];

  if (inputs.implementOutcome !== 'advance') {
    reasons.push('implement did not advance');
  }

  if (isRead) {
    const succ = inputs.criteriaSucceeded?.length ?? 0;
    const errs = Array.isArray(last?.criteriaErrors) ? last.criteriaErrors.length : 0;
    if (succ === 0) {
      reasons.push(`zero of ${succ + errs} criteria succeeded`);
    }
  } else {
    const reviewClean =
      inputs.reviewPolicy === 'none' ||
      inputs.reviewVerdict === 'approved' ||
      (inputs.reviewVerdict === 'changes_required' &&
        inputs.reworkApplied === true &&
        inputs.reworkError === undefined &&
        (inputs.unaddressedFindingIds ?? []).length === 0);

    if (!reviewClean) {
      const unaddressed = inputs.unaddressedFindingIds ?? [];
      if (unaddressed.length > 0) {
        reasons.push(`rework left ${unaddressed.length} findings unaddressed: ${unaddressed.slice(0, 5).join(', ')}`);
      } else if (inputs.reviewVerdict === 'changes_required') {
        reasons.push('review required changes; rework did not advance cleanly');
      } else {
        reasons.push(`review verdict: ${inputs.reviewVerdict ?? 'unknown'}`);
      }
    }

    const commitClean =
      inputs.commitKind === 'committed' ||
      inputs.commitKind === 'no_op' ||
      inputs.autoCommit === false;
    if (!commitClean) {
      reasons.push('no commit landed and no clean no_op reason');
    }
  }

  if (reasons.length === 0) {
    const { reasons: rawReasons } = deriveCompletion(inputs);
    reasons.push(...rawReasons);
  }

  const preserved =
    proposed.message && /recover|re-?dispatch|retry|investigate/i.test(proposed.message)
      ? proposed.message
      : 'Recommend re-dispatch with the unresolved finding IDs and adjusted brief.';

  return {
    ...proposed,
    completed: false,
    message: `Task did not complete: ${reasons.join('; ')}. ${preserved}`,
  };
}
