import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorAuditTemplate: AnnotatorTemplate = {
  role: 'audit',
  onBriefCheck: 'For each finding, ask: is this the kind of issue the audit asked for? A security audit should produce security findings, not style nits.',
};
