// packages/core/src/lifecycle/annotate-parser.ts
//
// Deterministic precondition enforcer for the annotate stage.
// The LLM annotator may propose `completed: true`; this parser enforces
// the rules in spec §5.7.1 and may override to `false` with a synthesized
// recovery-suggesting message.

import type { AnnotatePayload } from './stage-io.js';
import type { LifecycleState } from './stage-plan-types.js';
import { deriveCompletion, extractCompletionInputs } from './derive-completion.js';

/**
 * Apply spec §5.7.1 preconditions to a proposed AnnotatePayload.
 * If any precondition fails, return a forced `completed: false` payload
 * with a synthesized message naming what blocked.
 */
export function applyAnnotatePreconditions(
  proposed: AnnotatePayload,
  state: LifecycleState,
): AnnotatePayload {
  const { completed, reasons } = deriveCompletion(extractCompletionInputs(state));

  if (!completed) {
    return {
      ...proposed,
      completed: false,
      message: reasons.length > 0
        ? `Completion blocked: ${reasons.join('; ')}`
        : (proposed.message ?? 'Completion blocked'),
    };
  }

  return { ...proposed, completed: true };
}
