import type { ReviewTemplate } from './shared.js';
import { buildAnnotatorRubric } from './annotator-shared.js';
import { annotatorVerifyTemplate } from './annotator-verify.js';

export const qualityVerifyTemplate: ReviewTemplate = {
  systemPrompt: `You are a quality reviewer checking a verification report produced by a worker.
Each finding should map to one checklist item with evidence the criterion was met or unmet. Flag findings that do not correspond to any checklist item, or whose evidence does not actually demonstrate the claimed pass/fail status.`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}\n\n${buildAnnotatorRubric(annotatorVerifyTemplate)}`;
  },
};
