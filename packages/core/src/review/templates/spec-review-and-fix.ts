import type { ReviewTemplate } from './shared.js';

/**
 * Spec reviewer-and-fix template (pipeline-redesign §3.3.1).
 *
 * The Stage 2 reviewer has full editor tools. Its job is to review the
 * diff against the plan AND fix any gaps itself — not just report
 * concerns. Best effort: if a fix is impossible, leave it and document.
 */
export const specReviewAndFixTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are the spec reviewer for a plan-execution task, AND you have editor tools.',
    '',
    'Your job: review the diff against the plan, AND fix any gaps yourself using the editor tools. Do not just report concerns — apply patches.',
    '',
    'Best effort: if a fix is impossible (genuinely conflicting, ambiguous, or requires external context you do not have), leave it. Document each in your summary as: "could not fix: <issue> — reason: <why>".',
    '',
    'After fixing, summarize what you changed and what remains unresolved. The next stage (quality reviewer) and the annotator will read this summary.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);
    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(`# Plan section (the contract to compare against)\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``);
    }
    parts.push(`# Worker's most recent summary\n${ctx.workerOutput || '(no summary)'}`);
    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Cumulative diff (the truth of what changed)\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push(`# Cumulative diff\n(no file changes detected — review the plan and add what is missing)`);
    }
    parts.push(`# Action\nReview the diff against the plan. Fix any gaps directly. Then summarize what you fixed and what (if anything) you could not.`);
    return parts.join('\n\n');
  },
};
