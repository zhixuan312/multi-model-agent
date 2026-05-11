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

  // ── Pipeline-redesign annotator-only fields (4.3.0+, spec §3.3) ──────
  // Read by `annotate-completion.ts` only. Spec/quality review-and-fix
  // templates ignore these.
  /** Spec reviewer's free-text summary from Stage 2. */
  specReviewerNotes?: string | null;
  /** Quality reviewer's free-text summary from Stage 3. */
  qualityReviewerNotes?: string | null;
  /** Spec reviewer provider error (Stage 2 transport failure). */
  specReviewError?: string | null;
  /** Quality reviewer provider error (Stage 3 transport failure). */
  qualityReviewError?: string | null;
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
