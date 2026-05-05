import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorVerifyTemplate: AnnotatorTemplate = {
  role: 'verification report',
  onBriefCheck: 'Each finding should map to one checklist item with evidence the criterion was met or unmet. Flag findings that do not correspond to any checklist item, or whose evidence does not actually demonstrate the claimed pass/fail status.',
};
