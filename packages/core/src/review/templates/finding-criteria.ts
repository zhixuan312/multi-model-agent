/**
 * Shared finding-quality criteria — the single source of truth for what
 * makes a "good finding" across the implementer + annotator stages.
 *
 * Tool sweep #12: the implementer prompts didn't share the annotator's
 * rubric, so workers emitted weak narrative (miscalibrated severity,
 * unsupported claims, speculative scope) and the annotator had to
 * either downgrade everything or rubber-stamp. This module gives
 * implementer prompts the SAME calibration the annotator uses, so the
 * two stages converge:
 *
 *   - Implementer is told what counts as evidence, what severity means,
 *     and what's out of scope BEFORE it writes findings.
 *   - Annotator validates the worker emitted them properly (its rubric
 *     in `annotator-shared.ts` references the same definitions).
 *
 * Result: fewer false positives, fewer missed criticals, less rework
 * (the worker self-aligned with what the reviewer will check). No
 * heuristic short-circuits — both stages run, they just spend less
 * time correcting each other.
 */

/** Severity ladder for read-only finding emission AND annotator
 *  validation. Same words, same meaning across stages. */
export const SEVERITY_LADDER = [
  'Severity (your judgment, calibrated to impact):',
  '- critical: must fix first — RCE, data loss, auth bypass, build broken, data corruption.',
  '- high:     real bug or security gap; blocks release.',
  '- medium:   real issue; fix soon; not blocking.',
  '- low:      minor or cosmetic issue; nice-to-fix; PASS in checklist contexts.',
  'Calibrate to actual impact, not how alarming the wording sounds. Workers commonly inflate — resist the urge.',
].join('\n');

/** Evidence-grounding rule. Required for every finding the worker
 *  emits. The annotator rejects findings without quotable evidence. */
export const EVIDENCE_GROUNDING = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Cite `file:line` (or `file:line-line` for a span) where the issue lives.',
  '- Quote the exact code excerpt or command output that demonstrates the issue. Don\'t paraphrase — quote.',
  '- If you cannot quote evidence directly, do NOT raise the finding. Note "investigation needed" in your summary instead.',
].join('\n');

/** Scope discipline. Workers commonly hallucinate citations into files
 *  they didn't open; this rule blocks the most common failure mode. */
export const SCOPE_DISCIPLINE = [
  'Scope discipline:',
  '- Only flag issues you verified by reading the file directly.',
  '- If a claim depends on caller behavior or files outside the requested scope, mark "investigation needed" in your summary — do NOT speculate.',
  '- Stay within the requested files. Don\'t audit dependencies you weren\'t asked about.',
].join('\n');

/** What the annotator (which doubles as the read-only quality reviewer)
 *  will check the worker's output against. Pre-fix the worker had no
 *  visibility into this; now it can self-align. */
export const ANNOTATOR_CHECK_AWARENESS_RO = [
  'After your output, an annotator validates each finding against this rubric:',
  '- Is the severity calibrated to actual impact (or did you inflate)?',
  '- Does the evidence directly support the claim, or is it paraphrased?',
  '- Is the finding within scope, or is it speculation about untouched files?',
  '- Is the finding on-brief (matching the focus / audit type / checklist item)?',
  'Findings that fail any of these are downgraded or dropped. Self-check before emitting.',
].join('\n');

/** Awareness block for delegate / execute-plan / retry implementers.
 *  Tells the worker what spec_review and quality_review will judge,
 *  so the worker self-aligns. */
export const REVIEWER_AWARENESS_AP = [
  'After your edit, two reviewers see the cumulative diff (every change since task start):',
  '',
  '1. SPEC reviewer — "does the diff fulfill the brief?"',
  '   - APPROVED requires: every brief item present in the diff, no missing pieces, no out-of-scope edits.',
  '   - CHANGES_REQUIRED requires: a concrete concern tied to a specific diff line.',
  '   - Empty diff = changes_required UNLESS the brief explicitly requested a no-op.',
  '',
  '2. QUALITY reviewer — "is the diff sound, safe, maintainable?"',
  '   - Flags: correctness bugs, broken tests, races, security gaps, speculative dependencies.',
  '   - Does NOT flag: stylistic preferences, comment bikeshedding, unrelated pre-existing code.',
  '',
  'Self-check before declaring done:',
  '- Implemented EVERY item in the brief? (no gaps)',
  '- No edits OUTSIDE the brief? (no scope creep)',
  '- If your edit affects callers / tests not in your filePaths, note them in your summary — even if you can\'t update them.',
  '- Are the changes minimal and verifiable, or could they be smaller?',
].join('\n');
