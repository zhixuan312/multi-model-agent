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
}

export interface ReviewTemplate {
  systemPrompt: string;
  buildUserPrompt(ctx: ReviewTemplateContext): string;
}
