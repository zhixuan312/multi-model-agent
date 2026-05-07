import type { RunnerShell } from '../providers/runner-shell.js';
import { AnnotatorPromptBuilder, type AnnotatorRoute } from './annotator-prompt-builder.js';
import { AnnotatorOutputParser, type AnnotatorParseResult } from './annotator-output-parser.js';
import { annotatorAuditTemplate } from './templates/annotator-audit.js';
import { annotatorReviewTemplate } from './templates/annotator-review.js';
import { annotatorVerifyTemplate } from './templates/annotator-verify.js';
import { annotatorDebugTemplate } from './templates/annotator-debug.js';
import { annotatorInvestigateTemplate } from './templates/annotator-investigate.js';

export interface AnnotatorInput {
  workerOutput: string;
  brief: string;
  cwd: string;
  route?: AnnotatorRoute;
}

const DEFAULT_ANNOTATOR_TEMPLATES = {
  audit: annotatorAuditTemplate,
  review: annotatorReviewTemplate,
  verify: annotatorVerifyTemplate,
  debug: annotatorDebugTemplate,
  investigate: annotatorInvestigateTemplate,
} as const;

export class AnnotatorEngine {
  private builder = new AnnotatorPromptBuilder(DEFAULT_ANNOTATOR_TEMPLATES);
  private parser = new AnnotatorOutputParser();

  constructor(private shell: RunnerShell) {}

  async annotate(input: AnnotatorInput): Promise<AnnotatorParseResult> {
    const route: AnnotatorRoute = input.route ?? 'audit';
    const prompt = this.builder.build(route, {
      workerOutput: input.workerOutput,
      brief: input.brief,
    });
    const result = await this.shell.run({
      systemPrompt: prompt,
      userMessage: 'Annotate the findings above.',
      toolDefinitions: [],
      maxTurns: 5,
      cwd: input.cwd,
    });
    return this.parser.parse({
      finalAssistantText: result.finalAssistantText,
      errorCode: result.errorCode,
    });
  }
}
