import type { ReviewerTemplate } from '../reviewer-prompt-builder.js';

export const diffTemplate: ReviewerTemplate = {
  build({ artifact, brief }) {
    return [
      'You are reviewing a mechanical refactor in a single pass. No rework loop is available.',
      '',
      'Reply with EXACTLY one of:',
      '- APPROVE',
      '- CONCERNS: <comma-separated short concern messages>',
      '- REJECT: <one-line reason>',
      '',
      '## Context',
      brief,
      '',
      '## Diff',
      '```diff',
      artifact,
      '```',
    ].join('\n');
  },
};
