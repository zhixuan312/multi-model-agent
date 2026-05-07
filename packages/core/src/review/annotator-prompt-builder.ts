import { ANNOTATOR_RUBRIC, type AnnotatorPromptContext, type AnnotatorTemplate } from './templates/annotator-shared.js';

export type AnnotatorRoute = 'audit' | 'review' | 'verify' | 'debug' | 'investigate';

export class AnnotatorPromptBuilder {
  constructor(
    private templates: Record<AnnotatorRoute, AnnotatorTemplate>,
  ) {}

  build(route: AnnotatorRoute, ctx: AnnotatorPromptContext): string {
    return assembleAnnotatorPrompt(this.templates[route], ctx);
  }
}

export function assembleAnnotatorPrompt(template: AnnotatorTemplate, ctx: AnnotatorPromptContext): string {
  return `You are reviewing a ${template.role} produced by a worker.

The user requested a ${template.role}. The brief was:

${ctx.brief}

## On-brief check (per finding)

${template.onBriefCheck}

## Worker output to extract findings from

${ctx.workerOutput}

${ANNOTATOR_RUBRIC}`;
}
