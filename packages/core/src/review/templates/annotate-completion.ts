import type { ReviewTemplate } from './shared.js';

/**
 * Completion annotator template (pipeline-redesign §3.3.3).
 *
 * Read-only. Emits a single ```json fenced block with structured
 * completion data. The handler runs the verify command BEFORE invoking
 * this annotator and passes the result via ctx.verifyResult; the parser
 * overlays it onto the final annotation (the annotator itself does not
 * need to emit the verify field).
 */
export const annotateCompletionTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are a completion annotator for a plan-execution task. You have READ-ONLY tools (no editor).',
    '',
    'Output a single ```json fenced code block — no prose before or after the fenced block. The schema:',
    '',
    '```json',
    '{',
    '  "completionPercent": <int 0..100>,',
    '  "perStep": [',
    '    { "step": "<step heading from plan>", "status": "done"|"partial"|"missing", "note": "<short note or null>" }',
    '  ],',
    '  "concerns": ["<short concern strings>"]',
    '}',
    '```',
    '',
    'How to fill:',
    '- Identify the discrete steps in the plan section (numbered headings, bullet items, or other clear demarcation). For each, decide done / partial / missing based on whether the diff and reviewer notes show evidence the step was satisfied.',
    '- `completionPercent` ≈ `round((done + 0.5 * partial) / total_steps * 100)`. You may adjust by ±10 if a partial step is much closer to done or missing than 50%.',
    '- If you cannot identify discrete steps (e.g., plan is a single paragraph), emit `perStep: []` and judge `completionPercent` holistically. The downstream code accounts for this case.',
    '- `concerns` is a short list of remaining issues the main agent should know about — TODOs left in code, unresolved reviewer notes, verify failures, etc.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(`# Plan section\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``);
    }
    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Final cumulative diff\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push(`# Final cumulative diff\n(no file changes detected)`);
    }
    if (ctx.specReviewerNotes) {
      parts.push(`# Spec lint report\n${ctx.specReviewerNotes}`);
    }
    if (ctx.specReviewError) {
      parts.push(`# Spec reviewer ERROR (call failed)\n${ctx.specReviewError}`);
    }
    if (ctx.qualityReviewerNotes) {
      parts.push(`# Quality lint report\n${ctx.qualityReviewerNotes}`);
    }
    if (ctx.qualityReviewError) {
      parts.push(`# Quality reviewer ERROR (call failed)\n${ctx.qualityReviewError}`);
    }
    if (ctx.reworkApplied === true && ctx.reworkOutput) {
      parts.push(`# Rework worker's summary (applied fixes)\n${ctx.reworkOutput}`);
    } else if (ctx.reworkApplied === false) {
      parts.push(`# Rework stage\n(skipped — both reviewers approved)`);
    }
    if (ctx.reworkError) {
      parts.push(`# Rework ERROR\n${ctx.reworkError}`);
    }
    if (ctx.verifyResult && ctx.verifyResult.ran) {
      const status = ctx.verifyResult.passed ? 'PASSED' : 'FAILED';
      parts.push(`# Verify command output (status: ${status}, exitCode: ${ctx.verifyResult.exitCode})\n\n\`\`\`\n${ctx.verifyResult.tailOutput || '(no output)'}\n\`\`\``);
    }
    parts.push(`# Action\nProduce the single fenced JSON block per the schema in the system prompt. No prose outside the block.`);
    return parts.join('\n\n');
  },
};
