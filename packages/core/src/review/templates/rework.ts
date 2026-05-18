import type { ReviewTemplate } from './shared.js';

export const reworkTemplate: ReviewTemplate = {
  systemPrompt: [
    'You are the REWORK worker. The implementer ran, then two reviewers (spec + quality) lint-checked the result and produced deviations.',
    'Your job: fix every deviation. You have FULL editor tools.',
    '',
    'CRITICAL: this is a SINGLE-PASS pipeline. There is NO second rework round. After you, the annotator scores completeness and the commit gate fires. If you skip a fix, no commit lands.',
    '',
    'Per-deviation procedure:',
    '  1. Read the relevant file ONCE (skip if already read this turn).',
    '  2. Apply the fix with one edit call.',
    '  3. Move on. Do not re-read; do not re-evaluate.',
    '',
    'Hard rules:',
    '- Trust the reviewers — do not re-investigate whether the deviation is valid.',
    '- If a deviation is truly impossible to fix (conflicting constraints, missing source), write "could not fix: <deviation> — reason" in your summary and move on.',
    '- Read each file AT MOST ONCE in this stage.',
    '',
    'When done: write summary "Fixed: <list of deviations>. Could not fix: <list with reasons>." End your turn.',
    '',
    'workerStatus calibration (this is where rework workers commonly under-rate themselves):',
    '- "done"             — you applied a fix for EVERY listed deviation. This is the correct value even though the reviewer originally flagged concerns. Being asked to rework is not, by itself, a "concern" — addressing the rework IS the success path. Verification of the fix is the reviewer\'s responsibility on the next round — do not mark yourself failed because you couldn\'t independently verify.',
    '- "done_with_concerns" — you addressed every listed deviation AND noticed a NEW unrelated issue you couldn\'t fix in this turn. Put the new issue in `unresolved`.',
    '- "blocked" / "failed"  — you were unable to apply a fix for ONE OR MORE of the listed deviations (conflicting constraints, missing source, ambiguous instruction). Put those entries in the "Could not fix" line AND in `unresolved`.',
    'If your summary line is "Fixed: <every deviation>. Could not fix: (none)." then workerStatus MUST be "done".',
  ].join('\n'),

  buildUserPrompt(ctx) {
    // Warm follow-up: this rework turn always resumes the implementer's
    // thread. The brief, prior worker output, and current cumulative diff
    // are already in the resumed session's conversation history. Emit
    // only the NEW content — the reviewer's deviations to fix.
    const parts: string[] = [];
    if (ctx.priorConcerns && ctx.priorConcerns.length > 0) {
      parts.push(
        `# Reviewer deviations to fix\n${ctx.priorConcerns
          .map((c, i) => `${i + 1}. ${c}`)
          .join('\n')}`,
      );
    } else {
      parts.push('# Reviewer deviations to fix\n(none — should not have reached this stage; end immediately)');
    }
    parts.push(
      '# Action\n' +
      '1. Fix each deviation in order.\n' +
      '2. Apply one edit call per file. Do not re-read after editing.\n' +
      '3. Write your summary and end your turn.\n' +
      '4. In your final WorkerOutput JSON: set workerStatus to "done" if your "Could not fix" line is empty (every listed deviation was addressed). Reserve "failed" / "blocked" for deviations you could not address — having had concerns to begin with is not, in itself, a concern.',
    );
    return parts.join('\n\n');
  },
};
