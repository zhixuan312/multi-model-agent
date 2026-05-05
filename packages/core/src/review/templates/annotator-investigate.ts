import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorInvestigateTemplate: AnnotatorTemplate = {
  role: 'codebase investigation',
  onBriefCheck: 'Each finding should be relevant to the question. Findings may be code-level (file:line cited in evidence) or project-level synthesis (what was searched, what was not found). Flag findings whose evidence does not support the claim or whose claim drifts from the question.',
};
