import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorInvestigateTemplate: AnnotatorTemplate = {
  role: 'codebase investigation',
  onBriefCheck: 'Each finding should be relevant to the question.',
  evidenceRule: [
    '- Present-thing citations: real `file:line` from files actually read, with a quote or summary.',
    '- Absent-thing citations: explicit "searched <pattern> in <path>, no matches" — negative findings are legitimate answers and must NOT be downgraded for lacking a code quote.',
    '- Synthesis findings: cite each link in the reasoning chain by file:line.',
  ].join('\n'),
  scopeRule: [
    '- Wherever the question leads is in scope; the question may not name files.',
    '- Drift into unrelated code-review remarks is out of scope.',
  ].join('\n'),
};
