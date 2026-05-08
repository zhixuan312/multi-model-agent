import type { ReviewTemplate } from './shared.js';

/**
 * Diff reviewer — the final cross-check that looks at the cumulative
 * diff in isolation and decides if it's acceptable as a whole.
 *
 * Tool sweep #6 fix: the template name was a misnomer pre-fix —
 * the reviewer received only the worker's text summary, never the
 * actual diff. Now it sees the diff (matches the name).
 */
export const diffTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are reviewing the cumulative diff produced by all rework rounds. Decide whether the overall change is acceptable.',
    '',
    'Reply with EXACTLY one of these single-line verdicts:',
    '- `APPROVE` — the diff is acceptable as-is.',
    '- `CONCERNS: <one-line summary of concerns>` — the diff has flaws but is on the right track.',
    '- `REJECT: <one-line reason>` — the diff is wrong enough that it should not be applied.',
    '',
    'Decision criteria:',
    '- Is the diff scoped to what the brief asked for? Out-of-scope edits are a CONCERN at minimum.',
    '- Are the changes internally consistent (e.g., a renamed symbol updated everywhere it appears in the diff)?',
    '- Does the diff introduce obvious correctness or security issues that the spec/quality reviews missed?',
    '',
    'Do NOT re-litigate the brief itself — that is the spec reviewer\'s job. Focus on the diff as a whole.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);
    parts.push(`# Worker's most recent summary\n${ctx.workerOutput || '(no summary)'}`);

    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Cumulative diff (what you are reviewing)\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push(`# Cumulative diff\n(no file changes detected — APPROVE only if the brief requested a no-op)`);
    }

    parts.push(`# Decide\nReply with one of APPROVE, CONCERNS: <text>, or REJECT: <text>.`);

    return parts.join('\n\n');
  },
};
