import type { ReviewTemplate } from './shared.js';

/**
 * Spec compliance reviewer — reframed in 4.2.3 for targeted-advice
 * output (instead of diagnostic complaints).
 *
 * The reviewer's job is split:
 *   1. Approve when the diff matches the plan, OR
 *   2. Tell the implementer EXACTLY WHAT TO CHANGE — with concrete
 *      "replace X with Y", "add this verbatim", "remove this line"
 *      instructions. NOT free-text descriptions of problems.
 *
 * Why this matters: when concerns are diagnostic ("the function omits
 * the entered filter"), the rework round re-implements from scratch
 * and paraphrases again. When concerns are mechanical instructions
 * ("Add `if (!stage?.entered) continue;` after line 22"), the rework
 * round applies them with low cognitive overhead.
 *
 * The reviewer is the COMPLEX tier (gpt-5.4) — it's capable of producing
 * actionable patch instructions. The reworker (also complex on round 2+)
 * is the MECHANICAL applier of those instructions.
 *
 * Same JSON output shape as before — `{verdict, concerns: string[]}` —
 * just with stricter expectations on what each concern string contains.
 */
export const specTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are a spec compliance reviewer for plan execution. Your job is one of two things:',
    '',
    '  (a) APPROVE the diff when it matches the plan, OR',
    '  (b) Emit TARGETED INSTRUCTIONS the implementer can apply mechanically to align the diff with the plan.',
    '',
    'You are NOT here to describe problems. You are here to either approve, or to tell the implementer exactly what to do next.',
    '',
    'Reply with a JSON block: {"verdict":"approved"|"changes_required","concerns":["..."]}.',
    '',
    'Verdict rules:',
    '- "approved": the diff matches the plan section\'s code blocks character-for-character AND covers every step the plan listed. The "concerns" list MUST be empty.',
    '- "changes_required": at least one targeted instruction. An empty diff = changes_required (unless the brief explicitly requested a no-op).',
    '',
    'How to write each concern (this is the part that determines whether the rework will succeed):',
    '',
    '  Bad concern (diagnostic — DO NOT WRITE):',
    '    "The function omits the entered filter."',
    '    "The test file has 4 tests but the plan prescribes 6."',
    '    "The implementation paraphrases the plan\'s code."',
    '',
    '  Good concern (targeted instruction — WRITE LIKE THIS):',
    '    "In packages/core/src/lifecycle/shared-compute.ts, between lines 21-22, add `if (!stage?.entered) continue;` (verbatim from plan step 4)."',
    '    "Add 2 missing tests by copying verbatim from the plan section: (a) the case named `\'skips non-entered stages even when they carry a cost\'`, (b) the case named `\'returns 0 (honest-zero) when every stage has null cost\'`."',
    '    "Replace the function body with the plan\'s verbatim code block from step 4 (search the plan section for the line `export function computeAggregateCost`). Do not paraphrase."',
    '',
    'Each concern must include: WHERE to apply it (file + line range or anchor), WHAT to apply (the verbatim text from the plan or a precise edit), and the ACTION (replace / add / remove / copy verbatim from plan step N).',
    '',
    'Verbatim plan-code enforcement (when the user prompt contains a "Plan section" block):',
    '- For every triple-backtick code block inside the plan section: the worker\'s diff MUST contain that block character-for-character (same names, signatures, comments, imports, control flow, return shape).',
    '- A "semantically equivalent" rewrite is NOT approval — it is CODE SUBSTITUTION; emit a targeted instruction to replace with the plan\'s verbatim code.',
    '- Distinguish from reconciliation: when the worker substituted because the plan named a symbol that does NOT exist in source AND used the actual source symbol, that\'s reconciliation — APPROVED, provided the worker noted it in their summary.',
    '',
    'You do not see future rework rounds. Decide on this evidence alone. The implementer reads your concerns as instructions to apply — write them so they can be applied.',
  ].join('\n'),

  buildUserPrompt(ctx) {
    const parts: string[] = [];
    parts.push(`# Task brief\n${ctx.brief}`);

    if (ctx.planContext && ctx.planContext.trim().length > 0) {
      parts.push(
        `# Plan section (verbatim source of truth)\n\nThis is what the plan author wrote — character-for-character. The diff below MUST match every code block in this section verbatim, and must show evidence of every numbered step. When emitting concerns, quote the verbatim plan code the implementer should apply.\n\n\`\`\`markdown\n${ctx.planContext.trim()}\n\`\`\``,
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

    parts.push(`# Decide\nApprove if the diff matches the plan section verbatim AND covers every step. Otherwise emit targeted instructions (where + what verbatim text + action) the implementer can apply mechanically. Reply with the JSON block specified in the system prompt.`);

    return parts.join('\n\n');
  },
};
