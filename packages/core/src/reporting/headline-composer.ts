export interface HeadlineTemplate {
  compose(input: { taskBrief: string; report: unknown; status: string }): string;
}

export class HeadlineComposer {
  constructor(private template: HeadlineTemplate) {}

  compose(input: { taskBrief: string; report: unknown; status: string }): string {
    return this.template.compose(input);
  }
}
