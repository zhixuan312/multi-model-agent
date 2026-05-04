import type { AnnotatorTemplate } from '../annotator-prompt-builder.js';
import { ANNOTATOR_RUBRIC } from '../annotator-prompt-builder.js';

export const investigateTemplate: AnnotatorTemplate = {
  build({ implFindings }) {
    return [
      'You are an annotator reviewing findings from a codebase investigation.',
      '',
      '## On-brief check (per finding)',
      '',
      'Each finding should be relevant to the question. Findings may be',
      'code-level (file:line cited in evidence) or project-level synthesis',
      '(what was searched, what was not found). Flag findings whose evidence',
      'does not support the claim or whose claim drifts from the question.',
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
