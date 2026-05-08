import type { AnnotatorTemplate } from './annotator-shared.js';

export const annotatorVerifyTemplate: AnnotatorTemplate = {
  role: 'verification report',
  onBriefCheck: 'Each finding should map to one checklist item with evidence the criterion was met or unmet.',
  evidenceRule: [
    '- Each Finding must map 1:1 to a checklist item.',
    '- Evidence is execution output (test/build/command output) OR a code reference (`file:line`).',
    '- A claimed PASS without evidence is speculation; downgrade or drop.',
    '- Severity binding: PASS = low; FAIL = medium or high based on impact.',
  ].join('\n'),
  scopeRule: [
    '- Only checklist items are in scope. Findings not tied to a checklist item are off-brief.',
    '- All checklist items should be covered (one Finding per item, in order).',
  ].join('\n'),
};
