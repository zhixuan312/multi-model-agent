/**
 * Debug-specific implementer criteria.
 *
 * DEBUG'S PURPOSE — read this before adding categories.
 * mma-debug is hypothesis-driven root-cause investigation. The output is
 * a fix specification, not a hint. The success criterion is:
 *
 *   "Could a maintainer who reads ONLY your debug report apply the fix,
 *    reproduce the original failure, verify the fix, and re-merge —
 *    without redoing the investigation?"
 *
 * That criterion is what makes a finding load-bearing. A correctly-
 * identified line that is just a SYMPTOM (the real cause is upstream)
 * is the debug-equivalent of an unimplementable fix — it sends the
 * maintainer down the wrong path. A hypothesis with no falsifier is a
 * guess dressed up as a finding.
 *
 * Debug is hypothesis-driven; cross-file tracing is required, not
 * forbidden. Findings are evidence chains, not point observations.
 */

/**
 * The orientation block. Goes at the TOP of every debug prompt.
 *
 * Without an explicit purpose statement, workers default to "find a
 * suspicious line" — which often points at the symptom, not the cause.
 * With this orientation, they trace from the failure point upstream
 * until they hit something that, if changed, would prevent the failure.
 */
export const DEBUG_PURPOSE_ORIENTATION = [
  'Why this debug investigation exists:',
  'mma-debug produces a fix specification a maintainer can apply WITHOUT redoing the investigation. Your output replaces the maintainer\'s own root-cause work — not augments it.',
  '',
  'For your output to clear that bar, every finding must answer:',
  '- Reproduction: how does the maintainer trigger the failure (command, input, state)?',
  '- Symptom: where does the failure surface (file:line of the error, the failing assertion, the wrong output)?',
  '- Cause: where is the actual defect (file:line that, if changed, would prevent the failure)?',
  '- Trace: the evidence chain that links symptom to cause — each step a file:line citation or an observed value.',
  '- Fix: the specific change to make at the cause (PROPOSE only — read-only contract; the caller applies).',
  '- Falsifier: how the maintainer can verify the fix works (the assertion that should now pass, the wrong output that should now be right).',
  '',
  'A finding missing the trace from symptom to cause is a guess. A finding that names a symptom location as the cause is misdirection. Both are worse than no finding because they send the maintainer down the wrong path.',
  '',
  'The completion test: would a maintainer who reads only your report and the source code reproduce the failure, find the cited cause, apply the proposed fix, and confirm the falsifier — all without doing the investigation a second time?',
].join('\n');

export const EVIDENCE_RULE_DEBUG = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Each finding is a hypothesis with a supporting evidence chain. Cite `file:line` at every step of the chain.',
  '- The chain has at least three points: SYMPTOM (where the failure surfaces) → INTERMEDIATE STATE (the wrong value, the unexpected branch, the missing call) → CAUSE (the file:line that, if changed, would prevent the failure).',
  '- Evidence forms accepted: reproducer commands, captured logs / stack traces, observed values, and code-path traces with file:line per step.',
  '- Hypothesis-level findings with PARTIAL evidence are valid — that is how root-causing works. Show the reasoning chain. State which step is firm and which is conjecture.',
  '- A hypothesis with NO falsifier (no way to check if the proposed cause is right) is a guess, not a finding. Always state how the maintainer can verify the fix.',
  '- Severity reflects evidence strength AND impact: confirmed root cause that ships a wrong fix = `critical`; confirmed root cause = `high`; plausible candidate with most of the chain = `medium`; partial trace / multiple plausible explanations = `low` (or note in summary).',
].join('\n');

export const SCOPE_RULE_DEBUG = [
  'Scope:',
  '- Follow the failure path wherever it leads. Cross-file tracing is required.',
  '- Reproduction discovery IS in scope: if the caller did not provide reproduction steps, infer them from test files, error messages, or recent commits and state your inferred reproduction explicitly.',
  '- Pre-existing-vs-new separation: if multiple bugs are entangled in the same failure, separate them. Identify which is the one the caller asked about; note the others under "Other defects observed (out of scope for this investigation)".',
  '- Out of scope: applying fixes (debug is read-only — propose, do not apply); rewriting code; auditing unrelated subsystems; broadening into general code review.',
].join('\n');

/**
 * The failure-mode taxonomy for debug investigations.
 *
 * Without this block, workers default to "find a suspicious line" —
 * which catches surface symptoms but misses the chain upstream that
 * actually caused the failure. The 9 categories below are the patterns
 * a careful debugger would consciously check for.
 */
export const DEBUG_FAILURE_MODES = [
  'Patterns to consciously check for. Apply on EVERY debug investigation:',
  '',
  '1. SYMPTOM-NOT-CAUSE — the suspicious line you first hit is where the failure SURFACES, not where it is CAUSED. Trace upstream until you find a state that, if changed, prevents the failure. The cited cause must be upstream of the cited symptom in the call/data flow.',
  '2. SCAPEGOAT FILE — the failing test or the throwing line is in a file that is just the messenger. The actual defect lives in a file the failure passes through. Read the call stack / data path and place the finding at the source, not the sink.',
  '3. INCOMPLETE TRACE — the chain from symptom to cause has unfilled gaps ("...somewhere in the middleware..."). Each step in the trace must be a file:line citation or an observed value. Gaps mean the maintainer redoes the investigation.',
  '4. UNTESTED HYPOTHESIS — the proposed fix has no falsifier. Always state HOW the maintainer can verify the fix worked: which assertion now passes, which output is now right, which command no longer errors.',
  '5. PARALLEL CAUSES — more than one independent root cause is plausible. If the evidence is consistent with two unrelated mechanisms, name both as separate findings. Do NOT collapse them.',
  '6. PRE-EXISTING-VS-NEW ENTANGLEMENT — multiple bugs are entangled in one failure. Separate them. Identify which one the caller asked about; note the others under a separate section.',
  '7. WRONG FIX SCOPE — the proposed fix is broader than the cause requires (a refactor when a one-line fix would do) or narrower than the cause requires (a band-aid that masks the bug). Match fix scope to the cause depth.',
  '8. MISSING REPRODUCTION — there is no command, input, or state the maintainer can use to trigger the failure. Without reproduction the fix cannot be verified. If the caller did not provide one, infer it and state it explicitly.',
  '9. CONFIDENCE OVERSTATEMENT — the chain has gaps but the finding is filed at `high` severity. Calibrate severity to evidence strength: gaps in the chain = lower severity OR explicit "this is the most likely candidate; verify by X" caveat.',
  '',
  'Severity calibration for debug:',
  '- critical: confirmed root cause where applying the proposed fix incorrectly would ship a regression (e.g. fix at the wrong layer that hides the bug).',
  '- high: confirmed root cause with full chain symptom → cause → reproduction → falsifier. The maintainer can apply directly.',
  '- medium: plausible cause with most of the chain, one or two gaps the maintainer can fill. Mark gaps explicitly.',
  '- low: partial trace, multiple candidates, or hypothesis without sufficient evidence. Use sparingly — most findings should be medium or high.',
].join('\n');

/**
 * Counter-balance to the SEVERITY_LADDER's anti-inflation hint.
 *
 * The shared severity ladder warns against inflation. For debug, the
 * common failure is the OPPOSITE — workers stop at the first plausible
 * explanation (over-confidence on a shallow trace) rather than tracing
 * to the actual cause. This block tells the worker the typical debug
 * failure is shallow root-cause, not noisy hypothesis lists.
 */
export const THOROUGHNESS_REMINDER_DEBUG = [
  'Thoroughness expectation for debug investigations:',
  '- For non-trivial failures (test failure, runtime error, unexpected behavior), stopping at the first plausible explanation is the typical debug failure mode. Always check for SYMPTOM-NOT-CAUSE before filing a finding: ask "if I changed this line, would the failure still happen via a different path?"',
  '- The SEVERITY_LADDER warns against inflation. That warning is calibrated for code reviews — for debug, the common failure is OVER-CONFIDENCE on a shallow trace (calling a symptom location the cause). Apply the failure-mode taxonomy first; THEN calibrate severity.',
  '- Do not invent hypotheses to hit a quota. But if you have only one finding and the failure is non-trivial, double-check categories 1, 2, 3, and 5 (symptom-not-cause, scapegoat file, incomplete trace, parallel causes) — these are the ones investigators most often miss on first pass.',
  '- Limit yourself to 3-5 most-likely hypotheses. Do NOT enumerate implausible ones to pad the list.',
  '',
  'Symptom → cause walk (REQUIRED on every investigation):',
  '- Start at the SYMPTOM (where the failure surfaces — the error message, the failing assertion, the wrong output).',
  '- Walk UPSTREAM in the call/data flow. At each step, check whether the state at that point is consistent with the failure or already wrong. The point where the state first becomes wrong is the cause.',
  '- For each step in the walk, cite a file:line. If the walk crosses a function boundary, cite both sides (caller line + callee line).',
  '- Worked example. A test fails with `TypeError: cannot read property "id" of undefined` at `tests/users.test.ts:42` (assertion on the response). The walk: assertion sees `response.user === undefined`; the route handler at `src/handlers/getUser.ts:18` returns `{ user: rows[0] }` from a DB call; the DB call at `src/db/users.ts:34` returns `[]` for the test fixture id; the fixture loader at `tests/fixtures/users.ts:12` writes to a different table than the handler reads. → CAUSE is `tests/fixtures/users.ts:12` (wrong table). The TypeError at `tests/users.test.ts:42` is the SYMPTOM. A finding that named `getUser.ts:18` as the cause would have shipped a fix that adds null-checking — masking the bug instead of fixing it.',
  '- Most investigators miss findings of this shape on first pass because the failing line is loud and the upstream cause is quiet. The symptom → cause walk forces the trace.',
].join('\n');

export const ANNOTATOR_AWARENESS_DEBUG = [
  'After your output, an annotator validates each finding against this debug rubric:',
  '- Is each finding a hypothesis with a complete trace from symptom to cause (not a point observation at the symptom)?',
  '- Does the cited cause come UPSTREAM of the cited symptom in the call/data flow?',
  '- Is there a reproduction step the maintainer can use to trigger the failure?',
  '- Is there a falsifier the maintainer can use to verify the fix?',
  '- Did you propose fixes WITHOUT applying them (read-only contract)?',
  '- Is severity calibrated to evidence strength (gaps in chain = lower severity, not the same severity with hand-waving)?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped — but partial-evidence hypotheses with explicit "the gap is here, verify by X" notes are FULLY VALID, do NOT downgrade them as "speculation". Debug is speculation narrowed by evidence; hand-waving is the failure mode, not careful gap-marking.',
].join('\n');

import { parseCriteria, type CriterionEntry } from '../criteria-types.js';

/** Structured per-criterion array for parallel-criteria fan-out. */
export const DEBUG_CRITERIA: readonly CriterionEntry[] = parseCriteria(DEBUG_FAILURE_MODES);
