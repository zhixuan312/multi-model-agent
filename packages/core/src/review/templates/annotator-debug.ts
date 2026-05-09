import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorDebugTemplate: AnnotatorTemplate = {
  role: 'debugging hypothesis',
  onBriefCheck: 'Each finding should be a hypothesis with a complete trace from symptom to cause, not a point observation at the symptom. AND: the cited cause must come UPSTREAM of the cited symptom in the call/data flow — a finding that names a symptom location as the cause is misdirection (SYMPTOM-NOT-CAUSE failure mode). Findings consistent with the debug failure-mode taxonomy (symptom-not-cause, scapegoat file, incomplete trace, untested hypothesis, parallel causes, pre-existing-vs-new entanglement, wrong fix scope, missing reproduction, confidence overstatement) and backed by file:line citations at each step are valid even when the chain has marked gaps — partial-evidence hypotheses with explicit "the gap is here, verify by X" notes are FULLY VALID, do NOT downgrade them as "speculation".',
  evidenceRule: [
    '- Debug findings are hypotheses with REASONING CHAINS, not point observations.',
    '- Each finding must have at least three citations: SYMPTOM (where the failure surfaces) → INTERMEDIATE STATE (the wrong value, the unexpected branch) → CAUSE (the file:line that, if changed, would prevent the failure).',
    '- Evidence forms accepted: reproducer commands, captured logs / stack traces, observed values, code-path traces with file:line per step.',
    '- A finding with NO falsifier (no way to verify the proposed fix worked) is a guess, not a finding.',
    '- Cross-file tracing (symptom in one file, cause in another reachable via call/data flow) is REQUIRED and FULLY VALID — not "speculation about untouched files".',
    '- Severity reflects evidence strength AND impact: confirmed root cause that ships a wrong fix = critical; confirmed root cause with full chain = high; plausible candidate with most of the chain = medium; partial trace / multiple plausible explanations = low.',
  ].join('\n'),
  scopeRule: [
    '- Cross-file tracing is in scope and REQUIRED to follow the failure path. Cross-file findings are not out-of-scope just because the named files do not include the cause file.',
    '- Reproduction discovery is in scope: if no reproduction was provided, the worker should infer one and state it explicitly.',
    '- Pre-existing-vs-new separation is in scope: multiple bugs in one failure should be separated, with the answered one as the primary finding and others noted separately.',
    '- Out of scope: applied fixes (the worker should propose, not apply); unrelated code-review remarks; broadening into general code review of files not on the failure path.',
  ].join('\n'),
};
