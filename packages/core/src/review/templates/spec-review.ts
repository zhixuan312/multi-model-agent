import type { ReviewTemplate } from './shared.js';

export const specLintTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are the SPEC reviewer for a plan-execution task. You are LINT-ONLY — do NOT edit files.',
    'Your sole job: compare the on-disk state against the plan and emit a structured report.',
    'Read files as needed to verify. A separate REWORK stage will apply your findings.',
    '',
    'Output format (mandatory):',
    '',
    '## Verdict',
    'approved | changes_required',
    '',
    '## Deviations',
    '- <one short line per gap, naming the file and what is missing/wrong>',
    '- ...',
    '',
    'Rules:',
    '- "approved" means the diff fully implements the plan section. Trivial wording differences are OK.',
    '- "changes_required" when any plan step is missing, partial, or wrong on disk.',
    '- Each deviation must be specific enough that a rework worker can act on it without re-deriving.',
    '- If approved, write "## Deviations\\n(none)".',
    '- Do NOT use editor tools. Read-only investigation only. Editing is the rework stage\'s job.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);
    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(`# Plan section (the contract to compare against)\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``);
    }
    parts.push(`# Worker's summary\n${ctx.workerOutput || '(no summary)'}`);
    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Cumulative diff (current on-disk state)\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push('# Cumulative diff\n(no file changes detected)');
    }
    parts.push('# Action\nCompare diff vs plan. Emit the report. Do not edit.');
    return parts.join('\n\n');
  },
};
