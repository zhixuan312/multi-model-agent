import type { ReviewTemplate } from './shared.js';

export const specTemplate: ReviewTemplate = {
  systemPrompt: `You are a spec compliance reviewer. Check whether the implementer satisfied the task exactly.
Return a JSON block with: {"verdict":"approved"|"changes_required","concerns":["concern1",...]}`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}`;
  },
};
