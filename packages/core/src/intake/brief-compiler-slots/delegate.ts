import { REVIEWER_AWARENESS_AP } from '../../review/templates/finding-criteria.js';
import {
  DELEGATE_PURPOSE_ORIENTATION,
  DELEGATE_SCOPE_RULE,
  DELEGATE_FAILURE_MODES,
  COMPLETENESS_REMINDER_DELEGATE,
} from '../../tools/delegate/implementer-criteria.js';

export type ReviewPolicy = 'full' | 'quality_only' | 'diff_only' | 'none';

/**
 * Compile a delegate worker prompt.
 *
 * Structure (top-down):
 *   1. Orientation (why this exists, success criterion)
 *   2. The caller's brief (`prompt`)
 *   3. File constraint (when filePaths is set)
 *   4. Scope rule
 *   5. Failure-mode taxonomy
 *   6. Completeness reminder + brief-vs-diff walk + worked example
 *   7. Reviewer awareness (spec + quality self-check)
 *
 * Without (1), (4)-(6), workers calibrated on "implement something
 * good" tend to over-deliver (scope creep) or under-deliver (silent
 * partial fix). The orientation + taxonomy + completeness reminder
 * shifts the calibration to "smallest complete change" — minimal AND
 * complete simultaneously.
 */
export function compileDelegatePrompt(input: { prompt: string; filePaths?: string[] }): string {
  const filePathsClause = input.filePaths && input.filePaths.length > 0
    ? `\n\nFILE CONSTRAINT: write to exactly these path(s), no others, no renames: ${input.filePaths.map((p) => `\`${p}\``).join(', ')}.\n- Existing files in this list are pre-verified to read and modify.\n- Non-existent paths in this list are explicit OUTPUT TARGETS — create them.\n- Files NOT in this list are off-limits to write unless the brief\'s task genuinely requires touching them (call out the deviation in your summary).`
    : '';
  return [
    DELEGATE_PURPOSE_ORIENTATION,
    '',
    'Brief from the caller (this is the contract — implement exactly what it says):',
    '',
    input.prompt,
    filePathsClause,
    '',
    DELEGATE_SCOPE_RULE,
    '',
    DELEGATE_FAILURE_MODES,
    '',
    COMPLETENESS_REMINDER_DELEGATE,
    '',
    REVIEWER_AWARENESS_AP,
  ].join('\n');
}
