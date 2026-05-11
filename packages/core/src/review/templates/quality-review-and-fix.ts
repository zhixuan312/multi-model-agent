import type { ReviewTemplate } from './shared.js';

/**
 * Quality reviewer-and-fix template (pipeline-redesign §3.3.2).
 *
 * The Stage 3 reviewer has full editor tools. Reviews safety / correctness
 * / edge cases / error handling / security, and fixes risks directly.
 * Best effort: leave irreparable issues with explanation.
 */
export const qualityReviewAndFixTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are the quality reviewer for a plan-execution task, AND you have editor tools.',
    '',
    'Your job: review the diff for safety, correctness, edge cases, error handling, and security. Fix any risk you find using the editor tools. Do not just report — apply the fix.',
    '',
    'Best effort: if a fix is irreparable in this round (deeper design issue, missing requirements, conflicting constraints), leave it. Document each as: "could not fix: <issue> — reason: <why>".',
    '',
    'You are NOT reviewing against verbatim plan text — that was the spec reviewer\'s job. You are checking whether the implementation is sound, safe, and maintainable as code.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);
    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(`# Plan section (for context)\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``);
    }
    if (ctx.priorConcerns && ctx.priorConcerns.length > 0) {
      parts.push(`# Spec reviewer's summary\n${ctx.priorConcerns.join('\n\n')}`);
    }
    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Cumulative diff (after spec review-and-fix)\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push(`# Cumulative diff\n(no file changes detected)`);
    }
    parts.push(`# Action\nReview the diff for safety/correctness/security. Fix any risk directly. Then summarize what you fixed and what remains.`);
    return parts.join('\n\n');
  },
};
