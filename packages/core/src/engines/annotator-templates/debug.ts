import type { AnnotatorTemplate } from '../annotator-prompt-builder.js';
import { ANNOTATOR_RUBRIC } from '../annotator-prompt-builder.js';

export const debugTemplate: AnnotatorTemplate = {
  build({ implFindings }) {
    return [
      'You are an annotator reviewing findings from a debugging hypothesis.',
      '',
      '## On-brief check (per finding)',
      '',
      'Each finding should be a hypothesis, root-cause claim, or evidence',
      '(reproducer, error pattern, code path). Flag findings that do not',
      'logically follow from cited evidence or that exceed what the trace',
      'actually shows.',
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
