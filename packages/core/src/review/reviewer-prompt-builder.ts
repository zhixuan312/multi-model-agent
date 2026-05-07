import type { ReviewTemplate } from './templates/shared.js';

export type QualityReviewRoute = 'delegate' | 'execute-plan' | 'audit' | 'review' | 'verify' | 'investigate' | 'debug' | 'explore';

export class ReviewerPromptBuilder {
  constructor(
    private templates: {
      spec: ReviewTemplate;
      qualityForAP: ReviewTemplate;
      diff: ReviewTemplate;
    },
    private qualityTemplates: Partial<Record<QualityReviewRoute, ReviewTemplate>> = {},
  ) {}

  buildSpec(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.spec.systemPrompt,
      userPrompt: this.templates.spec.buildUserPrompt(ctx),
    };
  }

  buildQualityAP(ctx: { workerOutput: string; brief: string; route?: QualityReviewRoute }): { systemPrompt: string; userPrompt: string } {
    const template = (ctx.route !== undefined && this.qualityTemplates[ctx.route]) || this.templates.qualityForAP;
    return {
      systemPrompt: template.systemPrompt,
      userPrompt: template.buildUserPrompt(ctx),
    };
  }

  buildDiff(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.diff.systemPrompt,
      userPrompt: this.templates.diff.buildUserPrompt(ctx),
    };
  }
}
