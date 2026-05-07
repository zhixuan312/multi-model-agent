import type { ReviewTemplate } from './shared.js';
import { ANNOTATOR_RUBRIC } from './annotator-shared.js';

export const qualityAuditTemplate: ReviewTemplate = {
  systemPrompt: `You are a quality reviewer checking an audit produced by a worker.
For each finding, ask: is this the kind of issue the audit asked for? A security audit should produce security findings, not style nits.`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}\n\n${ANNOTATOR_RUBRIC}`;
  },
};
