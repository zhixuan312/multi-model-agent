import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorReviewTemplate: AnnotatorTemplate = {
  role: 'code review',
  onBriefCheck: 'For each finding, ask: is this within the requested focus area? A security review should produce security findings, not formatting nits.',
  evidenceRule: [
    '- Code-review findings must cite `file:line` from the named files.',
    '- Evidence must include a verbatim code quote, not paraphrase.',
    '- Findings without a quotable code excerpt are speculation; downgrade or drop.',
  ].join('\n'),
  scopeRule: [
    '- Only the named files are in scope. Behavior of direct callers/callees may be referenced when visible in the named files.',
    '- Speculation about untouched files is out of scope.',
    '- Doc/spec issues belong in an audit, not a review — flag as off-brief.',
  ].join('\n'),
};
