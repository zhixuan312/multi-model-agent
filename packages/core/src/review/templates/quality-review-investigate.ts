import type { ReviewTemplate } from './shared.js';
import { ANNOTATOR_RUBRIC } from './annotator-shared.js';

export const qualityInvestigateTemplate: ReviewTemplate = {
  systemPrompt: `You are a quality reviewer checking a codebase investigation produced by a worker.
Each finding should be relevant to the question. Findings may be code-level (file:line cited in evidence) or project-level synthesis (what was searched, what was not found). Flag findings whose evidence does not support the claim or whose claim drifts from the question.`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}\n\n${ANNOTATOR_RUBRIC}`;
  },
};
