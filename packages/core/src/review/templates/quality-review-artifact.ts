import type { ReviewTemplate } from './shared.js';

/**
 * Quality reviewer for artifact-producing routes (delegate, execute-plan,
 * retry).
 *
 * Tool sweep #6: pre-fix this template only saw `Task: <brief>` +
 * `Worker output: <text>`. Quality findings were rooted in the
 * worker's prose claim — false positives ("the worker claimed X but
 * didn't really") were common, and real regressions in the diff
 * could be missed if the worker's summary glossed over them.
 *
 * Post-fix: reviewer sees the cumulative diff. Findings must be
 * specific to diff lines.
 */
export const qualityAPTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are a code quality reviewer. Check whether the cumulative diff is sound, safe, and maintainable.',
    '',
    'Reply with a JSON block: {"verdict":"approved"|"concerns","concerns":["..."]}.',
    '',
    'Verdict rules:',
    '- "approved": the diff has no quality concerns worth blocking on. The "concerns" list MUST be empty.',
    '- "concerns": cite at least one specific concern, each tied to a specific diff line. Do not raise stylistic preferences not relevant to correctness, safety, or maintainability.',
    '- An empty diff is "approved" (nothing to review).',
    '',
    'Examples of legitimate concerns: input not validated; resource not closed; race condition introduced; tests broken; new dependency introduced without justification.',
    'Examples of out-of-scope concerns: bracket placement; comment punctuation; unrelated pre-existing code.',
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
      parts.push(`# Cumulative diff\n(no file changes detected — verdict should be "approved")`);
    }

    parts.push(`# Decide\nIs the cumulative diff sound, safe, and maintainable? Reply with the JSON block specified in the system prompt.`);

    return parts.join('\n\n');
  },
};
