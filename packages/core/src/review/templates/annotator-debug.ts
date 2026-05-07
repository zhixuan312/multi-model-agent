import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorDebugTemplate: AnnotatorTemplate = {
  role: 'debugging hypothesis',
  onBriefCheck: 'Each finding should be a hypothesis, root-cause claim, or evidence (reproducer, error pattern, code path). Flag findings that do not logically follow from cited evidence or that exceed what the trace actually shows.',
};
