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
    'You are the spec reviewer for a plan-execution task. You have FULL editor tools.',
    '',
    'CRITICAL: this is a SINGLE-PASS pipeline. There is NO rework round after you. After you, an annotator judges completeness; it does NOT fix anything. If you read-loop instead of editing, the annotator marks the work incomplete and NO COMMIT lands.',
    '',
    'Per-step procedure (apply to each numbered step in the plan section, in order):',
    '',
    '  1. EVALUATE: Is this step done? Use the diff and the worker summary as evidence.',
    '       - DONE → move on to the next step. Do not read or edit anything.',
    '       - NOT DONE / PARTIAL → continue to step 2.',
    '  2. READ the related file ONCE. Just one read per file, ever, for this whole stage.',
    '       - If you have ALREADY read this file earlier in this stage, SKIP the read and use what you already saw.',
    '  3. APPLY the fix with one edit call.',
    '  4. MOVE ON to the next step. Do not re-read to verify; do not re-evaluate the step you just fixed.',
    '',
    'Hard rules:',
    '- Read each file AT MOST ONCE in this stage. Re-reading is a defect.',
    '- After every read, the next action must be EDIT or MOVE ON. Never another read of the same file.',
    '- If a fix is impossible (genuinely conflicting, ambiguous, no available source): ACCEPT — write "could not fix: <step> — reason: <why>" in your summary and move on.',
    '',
    'When all steps are evaluated:',
    '- Write your summary: "Fixed: <list of steps>. Could not fix: <list with reasons>. Already done by worker: <list>."',
    '- End your turn. The annotator runs next.',
    '',
    'Read-budget guard: the readFile tool appends a warning to its return value when you read the same path more than once in this stage. If you see that banner, STOP. Edit or accept; do not re-read.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);
    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(`# Plan section (the contract to compare against)\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``);
    }
    parts.push(`# Worker's most recent summary\n${ctx.workerOutput || '(no summary)'}`);
    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(
        `# Cumulative diff (the current on-disk state — DO NOT re-read these files)\n\n` +
        `The diff below IS the truth of what is in each file. Edit against the diff's line numbers directly. ` +
        `Re-reading wastes turns and pushes you past the read-budget guard.\n\n` +
        `\`\`\`diff\n${ctx.diff}\n\`\`\``
      );
    } else {
      parts.push(`# Cumulative diff\n(no file changes detected — review the plan and add what is missing)`);
    }
    parts.push(
      `# Action — DECISIVE single-pass\n` +
      `1. Identify missing/wrong items from the diff vs plan comparison.\n` +
      `2. Apply each fix with one edit call per file. Do not re-read after editing.\n` +
      `3. Write your summary and end your turn. The annotator decides commit-readiness next; YOU do not get a second pass.`
    );
    return parts.join('\n\n');
  },
};
