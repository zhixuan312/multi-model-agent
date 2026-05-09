/**
 * Review-specific implementer criteria.
 *
 * Review examines source code in named files against a focus area
 * (security/correctness/performance/style). Findings should be
 * line-quotable — that's the natural shape of code defects.
 */

export const EVIDENCE_RULE_REVIEW = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Cite `file:line` (or `file:line-line` for a span) where the issue lives.',
  '- Quote the exact code excerpt or command output that demonstrates the issue. Don\'t paraphrase — quote.',
  '- If you cannot quote evidence directly from the named files, do NOT raise the finding. Note "investigation needed" in your summary instead.',
].join('\n');

export const SCOPE_RULE_REVIEW = [
  'Scope:',
  '- The named files. Behavior of direct callers/callees can be referenced when visible in those files.',
  '- Out of scope: speculation about untouched files; doc/spec issues (those belong in an audit, not a review); style nits when the focus area is security/correctness/performance.',
].join('\n');

export const ANNOTATOR_AWARENESS_REVIEW = [
  'After your output, an annotator validates each finding against this code-review rubric:',
  '- Is the finding within the requested focus area?',
  '- Does the evidence quote real code from the named files?',
  '- Is the severity calibrated to actual impact?',
  '- Is the finding within the requested scope, or is it about untouched code?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped.',
].join('\n');
