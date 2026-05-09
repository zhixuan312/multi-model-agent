/**
 * Verify-specific implementer criteria.
 *
 * Verify walks an explicit checklist; each Finding maps 1:1 to one
 * checklist item. Severity is bound to the result (PASS = low,
 * FAIL = medium/high based on impact). Anything outside the checklist
 * is out of scope, no exceptions.
 */

export const EVIDENCE_RULE_VERIFY = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Each Finding maps 1:1 to a checklist item (same count, same order).',
  '- Evidence is execution output (test/build/command output) OR a code reference (`file:line`) that demonstrates the criterion\'s status.',
  '- If you cannot demonstrate PASS, the result is FAIL — explain why in the Evidence field. Do NOT mark PASS without evidence.',
  '- Severity binding: PASS items are `low`. FAIL items are `medium` or `high` based on impact. Reserve `critical` for FAIL items that block the next step entirely.',
].join('\n');

export const SCOPE_RULE_VERIFY = [
  'Scope:',
  '- Strictly the checklist items. One Finding per item, in checklist order, no skips.',
  '- Out of scope: any issue not tied to a checklist item, however interesting. Such observations may be noted in your summary section, but do NOT emit them as Findings.',
].join('\n');

export const ANNOTATOR_AWARENESS_VERIFY = [
  'After your output, an annotator validates each finding against this verify rubric:',
  '- Does each Finding map to exactly one checklist item?',
  '- Does the evidence actually demonstrate the claimed PASS or FAIL?',
  '- Is the severity bound (PASS = low; FAIL = medium/high)?',
  '- Are all checklist items covered?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped.',
].join('\n');
