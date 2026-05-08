/**
 * Truly-shared finding criteria — the constants that apply *identically*
 * across every consumer. Per-tool blocks live next to each tool, not here.
 *
 *  - SEVERITY_LADDER: same severity ladder, same anti-inflation hint, same
 *    impact-anchored definitions for all 5 read-only tools.
 *  - REVIEWER_AWARENESS_AP: same spec+quality reviewer expectation across
 *    delegate / execute-plan / retry implementer prompts.
 *
 * Evidence + scope + annotator-awareness are calibrated per-tool; see
 * tools/<tool>/implementer-criteria.ts for each tool's blocks.
 */

export const SEVERITY_LADDER = [
  'Severity (your judgment, calibrated to actual impact):',
  '- critical: must fix first — RCE, data loss, auth bypass, build broken, data corruption.',
  '- high:     real bug or security gap; blocks release.',
  '- medium:   real issue; fix soon; not blocking.',
  '- low:      minor or cosmetic issue; nice-to-fix.',
  'Calibrate to actual impact, not how alarming the wording sounds. Workers commonly inflate — resist the urge.',
].join('\n');

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
