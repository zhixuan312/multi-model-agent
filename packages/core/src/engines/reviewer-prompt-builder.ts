export interface ReviewerTemplate {
  build(input: { artifact: string; brief: string }): string;
}

export class ReviewerPromptBuilder {
  constructor(
    private templates: {
      spec: ReviewerTemplate;
      qualityForAP: ReviewerTemplate;
      diff: ReviewerTemplate;
    },
  ) {}

  buildSpec(input: { artifact: string; brief: string }): string {
    return this.templates.spec.build(input);
  }

  buildQualityAP(input: { artifact: string; brief: string }): string {
    return this.templates.qualityForAP.build(input);
  }

  buildDiff(input: { artifact: string; brief: string }): string {
    return this.templates.diff.build(input);
  }
}
