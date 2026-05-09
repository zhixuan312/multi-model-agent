import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorReviewTemplate: AnnotatorTemplate = {
  role: 'code review',
  onBriefCheck: 'For each finding, ask: is this within the requested focus area (or universally applicable: security, correctness, performance apply to every code change)? AND: is this finding consistent with the code-review failure-mode taxonomy (test gap, cross-file ripple, pre-existing-bug-vs-new-regression, missing edge case, race, resource leak, backward-compat break, security regression, performance regression, implicit-contract assumption)? Findings that match the taxonomy and are backed by call-site references or sibling-test-file references are valid even when the cited code is not in the named files — do NOT downgrade them as "speculation about untouched files".',
  evidenceRule: [
    '- Code-review findings come in three valid shapes:',
    '  1. In-file quote: a verbatim code excerpt from the named files at `file:line`.',
    '  2. Cross-file ripple: a quote in the named file at `fileA:lineA` PLUS a call-site reference at `fileB:lineB` reachable via grep on the changed symbol. Both lines must be cited.',
    '  3. Test-gap reference: a quote of the changed line in the named file PLUS the natural-sibling test file path (e.g. `tests/foo.test.ts` for `src/foo.ts`). If no test file exists, that itself is the finding.',
    '- Implicit-contract findings are valid when they cite the changed line AND name the contract source (docstring, type, README) that does not state the assumption.',
    '- Findings without one of these forms are speculation; downgrade or drop.',
    '- Reasoning-based findings backed by call-site references (e.g. "this signature change breaks src/handlers/auth.ts:42") are FULLY VALID and the highest-value kind of code-review finding. Do NOT downgrade them as "speculation about untouched files."',
  ].join('\n'),
  scopeRule: [
    '- Named files are in scope. Behavior of direct callers/callees may be referenced when visible in the named files.',
    '- Cross-file ripples on changed public symbols ARE in scope when backed by a grep-able symbol reference. Do not penalize as out-of-scope.',
    '- Test-gap findings citing a sibling test file ARE in scope. Do not penalize as out-of-scope.',
    '- Speculation about unrelated untouched files is out of scope.',
    '- Doc/spec issues belong in an audit, not a review — flag as off-brief.',
    '- Pre-existing bugs (the diff did not introduce them) belong in a separate "Pre-existing — out of scope" section, not in the merge-blocking findings.',
  ].join('\n'),
};
