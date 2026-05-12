import type { ReviewTemplate, ReviewTemplateContext } from './templates/shared.js';

export type QualityReviewRoute = 'delegate' | 'execute-plan' | 'audit' | 'review' | 'investigate' | 'debug' | 'research';

export class ReviewerPromptBuilder {
  constructor(
    private templates: {
      spec: ReviewTemplate;
      qualityForAP: ReviewTemplate;
    },
    private qualityTemplates: Partial<Record<QualityReviewRoute, ReviewTemplate>> = {},
  ) {}

  buildSpec(ctx: ReviewTemplateContext): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.spec.systemPrompt,
      userPrompt: this.templates.spec.buildUserPrompt(ctx),
    };
  }

  buildQualityAP(ctx: ReviewTemplateContext & { route?: QualityReviewRoute }): { systemPrompt: string; userPrompt: string } {
    const template = (ctx.route !== undefined && this.qualityTemplates[ctx.route]) || this.templates.qualityForAP;
    return {
      systemPrompt: template.systemPrompt,
      userPrompt: template.buildUserPrompt(ctx),
    };
  }
}
