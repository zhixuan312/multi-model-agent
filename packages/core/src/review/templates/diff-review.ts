import type { ReviewTemplate } from './shared.js';

export const diffTemplate: ReviewTemplate = {
  systemPrompt: `You are reviewing a diff. Reply with EXACTLY one of: APPROVE, CONCERNS: <reasons>, or REJECT: <reason>`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}`;
  },
};
