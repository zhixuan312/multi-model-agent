export interface ReviewTemplateContext {
  workerOutput: string;
  brief: string;
  filesChanged?: string[];
  /**
   * Cumulative unified diff of every change made since task start,
   * across all rework rounds. Empty/undefined when no changes were
   * detected (or the route is read-only).
   *
   * Tool sweep #6: reviewer templates were operating blind on the
   * worker's text claim alone. Passing the diff lets each reviewer
   * be precise — verdicts are grounded in code evidence, not prose.
   */
  diff?: string;
  /**
   * Concrete concerns from previous reviewer rounds in this chain.
   * Round 1 sees an empty list; round 2+ sees what round 1 flagged
   * so it can verify "did the rework address X" rather than re-deriving.
   */
  priorConcerns?: string[];
  /**
   * For execute-plan tasks: the verbatim plan section the worker was
   * asked to execute, separate from `brief` (which contains the worker's
   * full prompt with orientation, fidelity rules, etc.). When set, the
   * spec reviewer compares the diff against this section's verbatim code
   * blocks character-for-character — semantically-equivalent rewrites
   * are CODE SUBSTITUTION, not approval. Unset for non-execute-plan
   * routes (delegate, audit, review, verify, debug, investigate).
   */
  planContext?: string;

  // ── Annotator-only fields (read by annotate-completion template) ────
  /** Spec lint-reviewer raw report. */
  specReviewerNotes?: string | null;
  /** Quality lint-reviewer raw report. */
  qualityReviewerNotes?: string | null;
  /** Spec lint-reviewer transport/return error. */
  specReviewError?: string | null;
  /** Quality lint-reviewer transport/return error. */
  qualityReviewError?: string | null;
  /** True if rework stage ran and applied edits. */
  reworkApplied?: boolean | null;
  /** Rework worker's free-text summary. */
  reworkOutput?: string | null;
  /** Rework transport/return error. */
  reworkError?: string | null;
  /** Deterministic verify command result (Stage 4 pre-step). */
  verifyResult?: {
    ran: boolean;
    passed: boolean | null;
    exitCode: number | null;
    command: string[];
    tailOutput: string | null;
  } | null;
}

export interface ReviewTemplate {
  systemPrompt: string;
  buildUserPrompt(ctx: ReviewTemplateContext): string;
}
