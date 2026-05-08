/**
 * Investigate-specific implementer criteria.
 *
 * Investigate answers a question about the codebase. Findings can be
 * code-level citations, project-level synthesis, or NEGATIVE results
 * ("searched X, not found"). The shared evidence rule that demands a
 * code quote for every finding wrongly suppresses negative results,
 * which are often the most useful answer to "is X still used?" or
 * "where does Y live?".
 *
 * Note: investigate does NOT use SEVERITY_LADDER — its findings are
 * citations and synthesis, not severity-rated issues.
 */

export const EVIDENCE_RULE_INVESTIGATE = [
  'Evidence grounding (REQUIRED for every citation):',
  '- For present things: `file:line` (or `file:line-line` for spans) plus a quote or summary of what you found.',
  '- For absent things: explicit `searched <pattern> in <path>, no matches` — negative findings are legitimate answers and should be emitted, not suppressed.',
  '- For synthesis findings (e.g. "X uses Y indirectly via Z"): cite each link in the chain by `file:line`.',
].join('\n');

export const SCOPE_RULE_INVESTIGATE = [
  'Scope:',
  '- Wherever the question leads. The question may not name files; you choose where to look.',
  '- Out of scope: drift into issues unrelated to the question; opportunistic code review of the code you are investigating (raise that separately, not as an investigation finding).',
].join('\n');

export const ANNOTATOR_AWARENESS_INVESTIGATE = [
  'After your output, an annotator validates each finding against this investigate rubric:',
  '- Does each finding answer some part of the question?',
  '- Are present-thing citations to real `file:line` from files you actually read?',
  '- Are negative findings explicit ("searched X, not found") rather than silent omissions?',
  '- Does the confidence reflect the strength of evidence?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped.',
].join('\n');
