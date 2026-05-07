import type { ReviewTemplate } from './shared.js';
import { ANNOTATOR_RUBRIC } from './annotator-shared.js';

export const qualityReviewTemplate: ReviewTemplate = {
  systemPrompt: `You are a quality reviewer checking a code review produced by a worker.
For each finding, ask: is this within the requested focus area? A security review should produce security findings, not formatting nits.`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}\n\n${ANNOTATOR_RUBRIC}`;
  },
};
