import type { AnnotatorTemplate } from '../annotator-prompt-builder.js';
import { ANNOTATOR_RUBRIC } from '../annotator-prompt-builder.js';

export const reviewTemplate: AnnotatorTemplate = {
  build({ implFindings }) {
    return [
      'You are an annotator reviewing findings from a code review.',
      '',
      '## On-brief check (per finding)',
      '',
      'For each finding, ask: is this within the requested focus area?',
      'A security review should produce security findings, not formatting',
      'nits. Flag findings that drift from the review brief or whose',
      'evidence does not actually support the claim.',
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
