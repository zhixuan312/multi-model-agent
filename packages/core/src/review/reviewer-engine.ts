import type { RunnerShell } from '../providers/runner-shell.js';
import { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
import { ReviewerOutputParser, type ReviewerParseResult, type ReviewerDiffParseResult } from './reviewer-output-parser.js';

// Re-exports for callers that previously imported templates and the builder
// from this module. Spec C11 puts templates in review/templates/ and the
// builder in review/reviewer-prompt-builder.ts; the re-exports keep one
// import surface for the engine + its collaborators.
export type { ReviewTemplate } from './templates/shared.js';
export { specTemplate } from './templates/spec-review.js';
export { qualityAPTemplate } from './templates/quality-review-artifact.js';
export { diffTemplate } from './templates/diff-review.js';
export { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
export type { QualityReviewRoute } from './reviewer-prompt-builder.js';

export class ReviewerEngine {
  private parser = new ReviewerOutputParser();

  constructor(
    private shell: RunnerShell,
    private builder: ReviewerPromptBuilder,
  ) {}

  async runSpec(state: {
    workerOutput: string;
    brief: string;
    cwd: string;
  }): Promise<ReviewerParseResult> {
    const { systemPrompt, userPrompt } = this.builder.buildSpec({
      workerOutput: state.workerOutput,
      brief: state.brief,
    });
    const result = await this.shell.run({
      systemPrompt,
      userMessage: userPrompt,
      toolDefinitions: [],
      maxTurns: 5,
      cwd: state.cwd,
    });
    return this.parser.parse(result.finalAssistantText ?? '');
  }

  async runQualityAP(state: {
    workerOutput: string;
    brief: string;
    cwd: string;
  }): Promise<ReviewerParseResult> {
    const { systemPrompt, userPrompt } = this.builder.buildQualityAP({
      workerOutput: state.workerOutput,
      brief: state.brief,
    });
    const result = await this.shell.run({
      systemPrompt,
      userMessage: userPrompt,
      toolDefinitions: [],
      maxTurns: 5,
      cwd: state.cwd,
    });
    return this.parser.parse(result.finalAssistantText ?? '');
  }

  async runDiff(state: {
    workerOutput: string;
    brief: string;
    cwd: string;
  }): Promise<ReviewerDiffParseResult> {
    const { systemPrompt, userPrompt } = this.builder.buildDiff({
      workerOutput: state.workerOutput,
      brief: state.brief,
    });
    const result = await this.shell.run({
      systemPrompt,
      userMessage: userPrompt,
      toolDefinitions: [],
      maxTurns: 5,
      cwd: state.cwd,
    });
    return this.parser.parseDiff(result.finalAssistantText ?? '');
  }
}
