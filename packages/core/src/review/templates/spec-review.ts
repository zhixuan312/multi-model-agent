import type { ReviewTemplate } from './shared.js';

/**
 * Spec compliance reviewer.
 *
 * Tool sweep #6 rewrite: pre-fix this template gave the LLM only
 * `Task: <brief>` + `Worker output: <text>`. The reviewer was
 * reviewing the worker's CLAIM, not the worker's WORK — it had no
 * way to verify whether the claim was true. Result: skeptical
 * reviewers defaulted to "changes_required" and triggered endless
 * rework spirals on already-correct edits.
 *
 * Post-fix: the reviewer also sees the cumulative diff (the truth)
 * and any prior reviewer concerns it should verify are addressed.
 * With evidence in hand, "changes_required" must point to a
 * specific diff line — no more vague rejections.
 */
export const specTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are a spec compliance reviewer. Your job is to decide whether the cumulative diff fulfills the task brief — nothing else.',
    '',
    'Reply with a JSON block: {"verdict":"approved"|"changes_required","concerns":["..."]}.',
    '',
    'Verdict rules:',
    '- "approved": the diff implements the brief, with no missing or wrong elements. The "concerns" list MUST be empty.',
    '- "changes_required": cite at least one concrete concern, each tied to a specific diff line or a specific missing element from the brief. Do NOT use this verdict for stylistic preferences not in the brief.',
    '- An empty diff (no files changed) is "changes_required" UNLESS the brief explicitly requested a no-op or "no change needed".',
    '- A diff that fully satisfies the brief is "approved" even if you would have written it differently.',
    '',
    'You do not see future rework rounds. Decide on this evidence alone.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);

    if (ctx.priorConcerns && ctx.priorConcerns.length > 0) {
      parts.push(
        `# Prior reviewer concerns from earlier rounds in this chain\nVerify the rework has addressed each one:\n` +
        ctx.priorConcerns.map((c, i) => `${i + 1}. ${c}`).join('\n'),
      );
    }

    parts.push(`# Worker's most recent summary\n${ctx.workerOutput || '(no summary)'}`);

    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Cumulative diff (the truth of what changed)\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push(`# Cumulative diff\n(no file changes detected)`);
    }

    parts.push(`# Decide\nDoes the cumulative diff fulfill the task brief? Reply with the JSON block specified in the system prompt.`);

    return parts.join('\n\n');
  },
};
