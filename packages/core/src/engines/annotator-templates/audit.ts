import type { AnnotatorTemplate } from '../annotator-prompt-builder.js';
import { ANNOTATOR_RUBRIC } from '../annotator-prompt-builder.js';

export const auditTemplate: AnnotatorTemplate = {
  build({ implFindings }) {
    return [
      'You are an annotator reviewing findings from a security audit.',
      '',
      '## On-brief check (per finding)',
      '',
      'For each finding, ask: is this the kind of issue the audit asked for?',
      'A security audit should produce security findings, not style nits.',
      'Flag findings that drift from the audit brief or whose evidence does',
      'not actually support the claim.',
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
