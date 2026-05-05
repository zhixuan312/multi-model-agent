import type { ReviewTemplate } from './templates/shared.js';

export class ReviewerPromptBuilder {
  constructor(
    private templates: {
      spec: ReviewTemplate;
      qualityForAP: ReviewTemplate;
      diff: ReviewTemplate;
    },
  ) {}

  buildSpec(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.spec.systemPrompt,
      userPrompt: this.templates.spec.buildUserPrompt(ctx),
    };
  }

  buildQualityAP(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.qualityForAP.systemPrompt,
      userPrompt: this.templates.qualityForAP.buildUserPrompt(ctx),
    };
  }

  buildDiff(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.diff.systemPrompt,
      userPrompt: this.templates.diff.buildUserPrompt(ctx),
    };
  }
}
