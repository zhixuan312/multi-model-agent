import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorVerifyTemplate: AnnotatorTemplate = {
  role: 'verification report',
  onBriefCheck: 'Each finding should map 1:1 to a checklist item with evidence in one of three valid shapes (EXECUTION command+output, FILE-LEVEL file:line+quote, or NEGATIVE "cannot verify"). AND: a PASS that rests on a prose claim from the work product alone — without execution output or file:line citation — is a rubber stamp; downgrade to FAIL with NEGATIVE evidence. Findings consistent with the verify failure-mode taxonomy (claim-without-evidence, stale evidence, implicit-criterion gap, partial coverage, conflated criteria, wrong-artifact evidence, assumed-PASS-on-untested) should be filed as the appropriate verdict — do NOT silently exclude implicit sub-criteria from PASS verdicts.',
  evidenceRule: [
    '- Each Finding must map 1:1 to a checklist item.',
    '- Evidence is one of three valid shapes:',
    '  1. EXECUTION: a command + its observed output (test name + pass/fail line, build output, lint result), with the relevant output line quoted.',
    '  2. FILE-LEVEL: `file:line` citation showing the implementation that satisfies (or fails) the criterion, with the relevant code excerpt quoted.',
    '  3. NEGATIVE: an explicit "cannot verify from this artifact" plus what would be needed to verify (a test run, a different file, a runtime check).',
    '- A claimed PASS without one of the three shapes is a rubber stamp; downgrade to FAIL with NEGATIVE evidence.',
    '- A "the work product says it is done" claim is NOT valid evidence — only execution output or file:line citations count for PASS.',
    '- Severity binding: PASS = low; FAIL = medium or high based on impact; FAIL on a release-blocking criterion = critical.',
    '- FAIL with NEGATIVE evidence ("cannot verify") is FULLY VALID and the correct verdict when the artifact is insufficient. Do NOT downgrade NEGATIVE-evidence FAILs to "cannot determine" or assumed-PASS.',
  ].join('\n'),
  scopeRule: [
    '- Only checklist items are in scope. Findings not tied to a checklist item are off-brief.',
    '- All checklist items should be covered (one Finding per item, in order, no skips).',
    '- IMPLICIT criteria embedded in a checklist item (e.g. "fix the bug" implies "regression test added") ARE in scope. A PASS verdict that silently excludes an implicit sub-criterion is a partial-coverage failure.',
  ].join('\n'),
};
