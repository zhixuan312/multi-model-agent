import type { ReviewTemplate } from './shared.js';

/**
 * Spec compliance reviewer — lenient mode (4.2.3+, rolled back from
 * strict verbatim enforcement).
 *
 * Earlier 4.2.3 iterations made the reviewer demand character-for-character
 * verbatim match against the plan's code blocks. This produced a chain of
 * pathologies on cheap workers (Haiku, MiniMax): reviewer correctly
 * flagged drift → worker couldn't mechanically apply the fix → rework
 * restart-looped on "let me re-read both files first" → 100+ tool calls
 * with zero edits → review_loop_capped.
 *
 * The 3.12.7 reviewer was completion-biased: "only flag changes_required
 * when there is positive evidence of omission". Workers always finished,
 * sometimes with paraphrased code that the reviewer accepted. The fidelity
 * gate moves to the main agent: it reads the terminal envelope, sees the
 * reviewer's advisory concerns (still emitted, just non-blocking), and
 * decides whether to patch inline.
 *
 * What changed vs the strict mode (now restored to lenient):
 * - "Only flag changes_required when there is positive evidence of
 *   omission" — no more verbatim-block enforcement
 * - Reviewer sees full file content via the diff, not just patches
 * - Concerns are diagnostic (what's wrong), not surgical patch
 *   instructions
 */
export const specTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are a spec compliance reviewer. Your job is to decide whether the cumulative diff fulfills the task brief.',
    '',
    'Reply with a JSON block: {"verdict":"approved"|"changes_required","concerns":["..."]}.',
    '',
    'Verdict rules:',
    '- "approved": the diff implements the brief, with no obvious missing or wrong elements. The "concerns" list MUST be empty. A diff that fully satisfies the brief is "approved" even if you would have written it differently.',
    '- "changes_required": cite at least one concrete concern, each tied to a specific diff line or a specific missing element from the brief. Do NOT use this verdict for stylistic preferences not in the brief.',
    '',
    'Completeness check: if the brief or plan section describes multiple files, sections, or components to modify, check whether each required target was adequately addressed. A target may be addressed by direct edit, by a shared-code change that covers it, or by already being correct. Only flag "changes_required" when there is POSITIVE EVIDENCE of omission — e.g., the plan names targets A, B, and C, but only A and B appear in the modified files with no indication that C was addressed. Do not flag "changes_required" merely because the worker chose a slightly different but functionally-equivalent implementation than the plan suggested.',
    '',
    'You do not see future rework rounds. Decide on this evidence alone.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);

    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(
        `# Plan section (for reference)\n\nThis is the plan section the worker was executing. Use it as context for what "complete" looks like — but the brief above is the contract, and functional equivalents to plan-prescribed code are acceptable.\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``,
      );
    }

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
