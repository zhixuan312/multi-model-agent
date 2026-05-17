import type { ReviewTemplate } from './shared.js';

export const legalOutcomes = ['found', 'clean'] as const;

export const OUTPUT_FORMAT = `
## Verdict
approved | changes_required

## Findings
Emit zero or more findings using EXACTLY this block format. Each finding is its own block.

## Finding N: <one-line claim>
- Severity: critical | high | medium | low
- Category: <one word — e.g. missing-step, wrong-file, broken-contract>
- Evidence: <verbatim excerpt from source, ≥20 chars — or (none) if inferable>
- Suggestion: <one sentence — how to fix it>

## Finding N+1:
...

If no findings, write "## Findings\n(none)".

## Outcome
found | clean

**Severity definitions (per spec-review):**
- **critical:** Plan step missed/wrong such that feature won't work
- **high:** Plan step partially implemented
- **medium:** Diverges in non-essential ways
- **low:** Cosmetic drift
`.trim();

export function specReviewPrompt(ctx: { brief: string; workerSummary: string; filesChanged: string[] }): string {
  return `You are the spec reviewer for this task.

Brief: ${ctx.brief}

Worker said: ${ctx.workerSummary}

Files changed: ${ctx.filesChanged.join(', ') || '(none)'}

${OUTPUT_FORMAT}`;
}

export const specLintTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are the SPEC reviewer for a plan-execution task. You are LINT-ONLY — do NOT edit files.',
    'Your sole job: compare the on-disk state against the plan and emit a structured report.',
    'Read files as needed to verify. A separate REWORK stage will apply your findings.',
    '',
    'Output format (mandatory):',
    '',
    OUTPUT_FORMAT,
    '',
    'Rules:',
    '- "approved" means the diff fully implements the plan section. Trivial wording differences are OK.',
    '- "changes_required" when any plan step is missing, partial, or wrong on disk.',
    '- Each finding must be specific enough that a rework worker can act on it without re-deriving.',
    '- If no findings, write "## Findings\\n(none)" followed by "## Outcome\\nclean".',
    '- If any findings, write "## Outcome\\nfound".',
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
