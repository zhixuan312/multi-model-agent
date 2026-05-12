import type { Session } from '../types/run-result.js';
import { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
import { ReviewerOutputParser, type ReviewerParseResult, ReviewerParseError } from './reviewer-output-parser.js';
import { HUMAN_LABEL } from '../lifecycle/stage-labels.js';

// Re-exports for callers. Spec C11 puts templates in review/templates/ and
// the builder in review/reviewer-prompt-builder.ts; the re-exports keep one
// import surface for the engine + its collaborators.
//
// Pipeline-redesign (4.3.0+): the AP-only templates (specTemplate,
// qualityAPTemplate, diffTemplate) were removed along with their consumer
// handlers (spec-chain, quality-chain, review-diff). New review-and-fix
// templates replace them for the artifact-producing pipeline.
export type { ReviewTemplate } from './templates/shared.js';
export { specLintTemplate } from './templates/spec-review.js';
export { qualityLintTemplate } from './templates/quality-review.js';
export { reworkTemplate } from './templates/rework.js';
export { annotateCompletionTemplate } from './templates/annotate-completion.js';
export { qualityAuditTemplate } from './templates/quality-review-audit.js';
export { qualityReviewTemplate } from './templates/quality-review-review.js';
export { qualityVerifyTemplate } from './templates/quality-review-verify.js';
export { qualityDebugTemplate } from './templates/quality-review-debug.js';
export { qualityInvestigateTemplate } from './templates/quality-review-investigate.js';
export { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
export type { QualityReviewRoute } from './reviewer-prompt-builder.js';

export type ReviewRoute = 'delegate' | 'execute-plan' | 'audit' | 'review' | 'verify' | 'investigate' | 'debug' | 'research';

export interface ReviewerInput {
  workerOutput: string;
  brief: string;
  cwd: string;
  route?: ReviewRoute;
  fileContents?: Record<string, string>;
  toolCallLog?: string[];
  filesWritten?: string[];
  diff?: string;
  priorConcerns?: string[];
  planContext?: string;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  bus?: import('../events/event-emitter.js').EventEmitter;
  batchId?: string;
  taskIndex?: number;
  tier?: string;
  stageLabel?: string;
}

export interface ReviewerCallResult extends ReviewerParseResult {
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null; durationMs: number | null };
}

export class ReviewerEngine {
  private parser = new ReviewerOutputParser();
  constructor(private builder: ReviewerPromptBuilder) {}

  async runSpec(session: Session, input: ReviewerInput): Promise<ReviewerCallResult> {
    const { systemPrompt, userPrompt } = this.builder.buildSpec({ ...input });
    const turn = await session.send(`${systemPrompt}\n\n${userPrompt}`, {
      stageLabel: input.stageLabel ?? HUMAN_LABEL.review,
    });
    const parsed = this.parser.parse(turn.output ?? '');
    return { ...parsed, cost: extractCost(turn) };
  }

  async runQualityAP(session: Session, input: ReviewerInput): Promise<ReviewerCallResult> {
    const { systemPrompt, userPrompt } = this.builder.buildQualityAP({ ...input });
    const turn = await session.send(`${systemPrompt}\n\n${userPrompt}`, {
      stageLabel: input.stageLabel ?? HUMAN_LABEL.review,
    });
    const parsed = this.parser.parse(turn.output ?? '');
    return { ...parsed, cost: extractCost(turn) };
  }

}

function extractCost(turn: import('../types/run-result.js').TurnResult): ReviewerCallResult['cost'] {
  const toolCallTotal = Object.values(turn.toolCallsByName).reduce((a, b) => a + b, 0);
  return {
    inputTokens: turn.usage.inputTokens ?? 0,
    outputTokens: turn.usage.outputTokens ?? 0,
    turnCount: turn.turns ?? 0,
    toolCallCount: toolCallTotal,
    costUSD: turn.costUSD ?? null,
    durationMs: turn.durationMs ?? null,
  };
}

export { ReviewerParseError };
