import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorReviewTemplate: AnnotatorTemplate = {
  role: 'code review',
  onBriefCheck: 'For each finding, ask: is this within the requested focus area? A security review should produce security findings, not formatting nits.',
};
