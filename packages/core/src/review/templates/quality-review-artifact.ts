import type { ReviewTemplate } from './shared.js';

export const qualityAPTemplate: ReviewTemplate = {
  systemPrompt: `You are a code quality reviewer. Check whether the implementation is sound, safe, and maintainable.
Return a JSON block with: {"verdict":"approved"|"concerns","concerns":["concern1",...]}`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}`;
  },
};
