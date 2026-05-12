import type { ReviewTemplate } from './shared.js';

export const qualityLintTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are the QUALITY reviewer for a plan-execution task. You are LINT-ONLY — do NOT edit files.',
    'Your scope: safety, correctness, error handling, edge cases, security, maintainability.',
    'You are NOT checking plan fidelity — that is the spec reviewer\'s job (their report runs in parallel).',
    'Read files as needed to verify. A separate REWORK stage will apply your findings.',
    '',
    'Output format (mandatory):',
    '',
    '## Verdict',
    'approved | changes_required',
    '',
    '## Deviations',
    '- <one short line per concern, naming the file and the risk>',
    '- ...',
    '',
    'Rules:',
    '- "approved" when the code is safe and correct enough to ship. Style nits do NOT block.',
    '- "changes_required" only for substantive risks (null-handling gap, missing error path, real edge case, security surface, etc.).',
    '- Each deviation must be specific enough that a rework worker can act on it without re-deriving.',
    '- If approved, write "## Deviations\\n(none)".',
    '- Do NOT use editor tools. Read-only investigation only.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);
    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(`# Plan section (for context)\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``);
    }
    if (ctx.diff && ctx.diff.length > 0) {
      parts.push(`# Cumulative diff (current on-disk state)\n\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
    } else {
      parts.push('# Cumulative diff\n(no file changes detected)');
    }
    parts.push('# Action\nReview for safety/correctness/edge-cases. Emit the report. Do not edit.');
    return parts.join('\n\n');
  },

  buildWarmFollowup(_ctx) {
    // Warm follow-up: spec review already loaded the brief, diff, and
    // planContext into this reviewer session's history on turn 1.
    // Emit only the NEW instruction — switch lens to safety/correctness
    // and emit the verdict + deviations report.
    return [
      '# Action — second pass: quality lens',
      '',
      'Now re-evaluate the SAME work in this thread through the QUALITY lens:',
      'safety, correctness, error handling, edge cases, security, maintainability.',
      '',
      'Output format (mandatory):',
      '',
      '## Verdict',
      'approved | changes_required',
      '',
      '## Deviations',
      '- <one short line per concern, naming the file and the risk>',
      '- ...',
      '',
      'Rules:',
      '- "approved" when the code is safe and correct enough to ship. Style nits do NOT block.',
      '- "changes_required" only for substantive risks.',
      '- Each deviation must be specific enough that a rework worker can act on it without re-deriving.',
      '- If approved, write "## Deviations\\n(none)".',
      '- Do NOT use editor tools. Read-only investigation only.',
    ].join('\n');
  },
};
