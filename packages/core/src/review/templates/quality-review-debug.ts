import type { ReviewTemplate } from './shared.js';
import { buildAnnotatorRubric } from './annotator-shared.js';
import { annotatorDebugTemplate } from './annotator-debug.js';

export const qualityDebugTemplate: ReviewTemplate = {
  systemPrompt: `You are a quality reviewer checking a debugging hypothesis produced by a worker.
Each finding should be a hypothesis, root-cause claim, or evidence (reproducer, error pattern, code path). Flag findings that do not logically follow from cited evidence or that exceed what the trace actually shows.`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}\n\n${buildAnnotatorRubric(annotatorDebugTemplate)}`;
  },
};
