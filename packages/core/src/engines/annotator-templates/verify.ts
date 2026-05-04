import type { AnnotatorTemplate } from '../annotator-prompt-builder.js';
import { ANNOTATOR_RUBRIC } from '../annotator-prompt-builder.js';

export const verifyTemplate: AnnotatorTemplate = {
  build({ implFindings }) {
    return [
      'You are an annotator reviewing findings from a verification report.',
      '',
      '## On-brief check (per finding)',
      '',
      'Each finding should map to one checklist item with evidence the',
      'criterion was met or unmet. Flag findings that do not correspond to',
      'any checklist item, or whose evidence does not actually demonstrate',
      'the claimed pass/fail status.',
      '',
      '## Input findings (re-judge every one; never drop)',
      '',
      '```json',
      JSON.stringify(implFindings, null, 2),
      '```',
      '',
      ANNOTATOR_RUBRIC,
    ].join('\n');
  },
};
