/**
 * Verify-specific implementer criteria.
 *
 * VERIFY'S PURPOSE — read this before adding categories.
 * mma-verify is the "are we lying when we say it's done?" gate. The
 * caller is about to claim work is complete to a stakeholder; the
 * verify output is the evidence trail for that claim. The success
 * criterion is:
 *
 *   "If you mark every item PASS, the caller can claim the work is
 *    done to a stakeholder without lying — and the stakeholder, given
 *    your evidence, can re-verify each item without re-doing the work."
 *
 * That criterion is what makes a finding load-bearing. A PASS marked
 * on the basis of a prose claim ("the bug is fixed") rather than
 * execution output or a file:line citation is a rubber stamp — the
 * verify-equivalent of an unimplementable fix. A criterion that the
 * worker could not actually verify from the supplied artifact must be
 * marked FAIL with "cannot verify from this artifact" — not assumed-
 * PASS or skipped.
 *
 * Verify walks an explicit checklist; each Finding maps 1:1 to one
 * checklist item. Severity is bound to the result (PASS = low,
 * FAIL = medium/high based on impact). Anything outside the checklist
 * is out of scope, no exceptions.
 */

/**
 * The orientation block. Goes at the TOP of every verify prompt.
 *
 * Without an explicit purpose statement, workers default to "rubber-
 * stamp the checklist" — marking PASS based on prose claims in the
 * work product instead of demanding execution-level evidence. With
 * this orientation, every PASS comes with evidence a stakeholder
 * could re-verify.
 */
export const VERIFY_PURPOSE_ORIENTATION = [
  'Why this verify exists:',
  'mma-verify is the "are we lying when we say it is done?" gate. Your output becomes the evidence trail behind a claim of completeness to a stakeholder. A wrong PASS here ships a false claim.',
  '',
  'For your output to clear that bar, every Finding must answer:',
  '- Item: the exact criterion text (preserve the caller\'s wording).',
  '- Result: PASS or FAIL — never "partial", "mostly", "in progress" — only PASS or FAIL.',
  '- Evidence: how the stakeholder could re-verify this PASS or FAIL themselves. Acceptable evidence shapes:',
  '    1. EXECUTION: a command + its observed output (test name + pass/fail line, build output, lint result).',
  '    2. FILE-LEVEL: `file:line` citation showing the implementation that satisfies (or fails to satisfy) the criterion.',
  '    3. NEGATIVE: an explicit "cannot verify from this artifact" with what would be needed to verify.',
  '',
  'A PASS without evidence is a rubber stamp — the worst possible verify failure mode. If you cannot demonstrate PASS, the result is FAIL, NOT assumed-PASS or skipped.',
  '',
  'The completion test: would a stakeholder who reads only your verification report and the named artifacts be able to re-verify each PASS themselves — and end up agreeing with each verdict?',
].join('\n');

export const EVIDENCE_RULE_VERIFY = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Each Finding maps 1:1 to a checklist item (same count, same order).',
  '- Evidence is one of three shapes:',
  '    1. EXECUTION: a command + its observed output. Quote the relevant line of the output (e.g. "12 passed, 0 failed", "✓ tests/foo.test.ts").',
  '    2. FILE-LEVEL: `file:line` citation showing the implementation that satisfies (or fails) the criterion. Include the quoted excerpt.',
  '    3. NEGATIVE: explicitly state "cannot verify from this artifact" plus what would be needed (a test run, a different file, a runtime check).',
  '- A "the work product says it is done" claim is NOT evidence — that is a rubber stamp. Only execution output or file:line citations count.',
  '- If you cannot demonstrate PASS, the result is FAIL — explain why in the Evidence field. Do NOT mark PASS without evidence and do NOT skip the item.',
  '- Severity binding: PASS items are `low`. FAIL items are `medium` or `high` based on impact. Reserve `critical` for FAIL items that block the next step entirely (a release-blocking criterion failed, an acceptance test failed, etc.).',
].join('\n');

export const SCOPE_RULE_VERIFY = [
  'Scope:',
  '- Strictly the checklist items. One Finding per item, in checklist order, no skips.',
  '- IMPLICIT criteria embedded in a checklist item ARE in scope. Example: a checklist item "fix the off-by-one bug in pagination" has an implicit sub-criterion "regression test added". If the implicit sub-criterion is not met, mark FAIL — do NOT split the item into two findings.',
  '- Out of scope: any issue not tied to a checklist item, however interesting. Such observations may be noted in your summary section, but do NOT emit them as Findings.',
].join('\n');

/**
 * The failure-mode taxonomy for verify.
 *
 * Without this block, workers tend to rubber-stamp PASS based on prose
 * claims in the work product. The 7 categories below are the patterns
 * a careful verifier would consciously check for.
 */
export const VERIFY_FAILURE_MODES = [
  'Patterns to consciously check for. Apply on EVERY checklist item:',
  '',
  '1. CLAIM-WITHOUT-EVIDENCE — the work product says "the bug is fixed" or "tests added" but you have no execution output and no file:line citation backing the claim. Marking PASS on prose alone is a rubber stamp. Demand evidence; mark FAIL if none.',
  '2. STALE EVIDENCE — the cited test run, build output, or commit was captured BEFORE the change being verified. Always check the timestamp / SHA / sequence — if the evidence predates the change, it does not demonstrate the criterion.',
  '3. IMPLICIT-CRITERION GAP — a checklist item like "fix bug X" has an implicit sub-criterion (regression test added, no behavior change in unrelated code). If a reasonable stakeholder reading the criterion would expect the implicit sub-criterion, mark FAIL when it is not met. Do NOT silently exclude the implicit sub-criterion from the verdict.',
  '4. PARTIAL COVERAGE — the criterion has multiple parts (e.g. "fix the bug AND add a regression test"). You only checked one part. Mark FAIL with explicit note of which part was satisfied and which was not. Do NOT mark PASS based on partial satisfaction.',
  '5. CONFLATED CRITERIA — evidence for criterion B is used to claim criterion A. Each Finding\'s Evidence must directly demonstrate the criterion in that Finding\'s Item field, not a neighboring criterion.',
  '6. WRONG-ARTIFACT EVIDENCE — the cited file or test name looks valid but does not actually exercise the change. Verify that the cited test name exists, that the cited line is in the cited file, and that the executed command produced the quoted output.',
  '7. ASSUMED-PASS-ON-UNTESTED — the criterion cannot be verified from the artifact provided. The correct verdict is FAIL with "cannot verify from this artifact, would need X" — NOT assumed-PASS, NOT skipped, NOT marked PASS-with-caveats.',
  '',
  'Severity calibration for verify:',
  '- critical: FAIL on a release-blocking criterion, acceptance test failure, security gate failure. The caller must NOT claim done.',
  '- high: FAIL on a substantial criterion that affects the work product\'s correctness or safety. The claim of done is materially wrong.',
  '- medium: FAIL on an implicit sub-criterion or partial coverage. The work is mostly done but the claim is partially overstated.',
  '- low: PASS — every PASS is `low` severity regardless of importance, because the verdict is "done correctly" and severity reflects departure from done.',
].join('\n');

/**
 * Counter-balance to the SEVERITY_LADDER's anti-inflation hint.
 *
 * The shared severity ladder warns against inflation. For verify, the
 * common failure is the OPPOSITE — workers UNDER-flag because they
 * accept prose claims at face value (rubber stamp). This block tells
 * the worker the typical verify failure is rubber-stamping, not
 * over-skeptical FAIL marking.
 */
export const THOROUGHNESS_REMINDER_VERIFY = [
  'Thoroughness expectation for verify:',
  '- The SEVERITY_LADDER warns against inflation. That warning is calibrated for code reviews — for verify, the common failure is the OPPOSITE: rubber-stamping PASS based on a prose claim instead of demanding execution-level evidence. Apply the failure-mode taxonomy first; THEN calibrate severity.',
  '- For each checklist item, ASK: "could a stakeholder reading my evidence re-verify this PASS themselves and reach the same conclusion?" If no — even if you believe the criterion is met — the verdict is FAIL with "cannot verify from this artifact".',
  '- Do not invent FAILs to hit a quota. But if every item is PASS and the artifact is non-trivial, double-check categories 1, 3, 4, and 7 (claim-without-evidence, implicit-criterion gap, partial coverage, assumed-PASS-on-untested) — these are the ones verifiers most often miss on first pass and the ones most likely to ship a false claim.',
  '',
  'Evidence-shape walk (REQUIRED on every checklist item):',
  '- For each item, before writing the Finding, ask: which of the three evidence shapes do I have? EXECUTION, FILE-LEVEL, or NEGATIVE?',
  '- If you cannot place your verdict in one of the three shapes, your evidence is insufficient — the verdict is FAIL with NEGATIVE evidence ("cannot verify from this artifact, would need X").',
  '- Worked example. Checklist item: "Bug #123 is fixed (the off-by-one in pagination)." Work product says "fixed in commit abc123 — added a guard at the loop boundary." Naive verdict: PASS based on the work product\'s claim. Correct verdict: read commit abc123, find the changed lines, cite `src/pagination.ts:48` with the actual changed expression, AND check for a regression test (implicit sub-criterion of "fix the bug"). If no test exists, mark FAIL with explicit note "fix is in place but no regression test was added — implicit sub-criterion not met". Do NOT mark PASS on the work-product claim alone, and do NOT silently exclude the implicit sub-criterion.',
  '- Most verifiers miss findings of this shape on first pass because the work product\'s prose is persuasive. The evidence-shape walk forces the demand for execution or file:line.',
].join('\n');

export const ANNOTATOR_AWARENESS_VERIFY = [
  'After your output, an annotator validates each finding against this verify rubric:',
  '- Does each Finding map to exactly one checklist item, in checklist order, with the criterion text preserved?',
  '- Does the evidence actually demonstrate the claimed PASS or FAIL — and is it one of the three valid shapes (EXECUTION, FILE-LEVEL, or NEGATIVE)?',
  '- Is the severity bound (PASS = low; FAIL = medium/high based on impact)?',
  '- Are all checklist items covered, including ones the worker thought were trivial?',
  '- For PASS items: could a stakeholder re-verify the PASS from the cited evidence alone?',
  '- For FAIL items: is the FAIL backed by a specific shortfall (which sub-criterion missed, which test failed, which file does not implement what the criterion requires)?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped — but FAIL with NEGATIVE evidence ("cannot verify from this artifact") is FULLY VALID and the correct verdict when the artifact is insufficient. Do NOT downgrade NEGATIVE-evidence FAILs to "cannot determine" or assumed-PASS.',
].join('\n');
