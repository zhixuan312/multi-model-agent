import type { RunnerShell } from '../providers/runner-shell.js';
import { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
import { ReviewerOutputParser, type ReviewerParseResult, type ReviewerDiffParseResult, ReviewerParseError } from './reviewer-output-parser.js';

// Re-exports for callers that previously imported templates and the builder
// from this module. Spec C11 puts templates in review/templates/ and the
// builder in review/reviewer-prompt-builder.ts; the re-exports keep one
// import surface for the engine + its collaborators.
export type { ReviewTemplate } from './templates/shared.js';
export { specTemplate } from './templates/spec-review.js';
export { qualityAPTemplate } from './templates/quality-review-artifact.js';
export { diffTemplate } from './templates/diff-review.js';
export { qualityAuditTemplate } from './templates/quality-review-audit.js';
export { qualityReviewTemplate } from './templates/quality-review-review.js';
export { qualityVerifyTemplate } from './templates/quality-review-verify.js';
export { qualityDebugTemplate } from './templates/quality-review-debug.js';
export { qualityInvestigateTemplate } from './templates/quality-review-investigate.js';
export { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
export type { QualityReviewRoute } from './reviewer-prompt-builder.js';

export type ReviewRoute = 'delegate' | 'execute-plan' | 'audit' | 'review' | 'verify' | 'investigate' | 'debug' | 'explore';

export interface ReviewerInput {
  workerOutput: string;
  brief: string;
  cwd: string;
  route?: ReviewRoute;
  fileContents?: Record<string, string>;
  toolCallLog?: string[];
  filesWritten?: string[];
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  /** Forwarded to RunInput so the running-headline sink + verbose stderr
   *  show which lifecycle stage the model is in (Spec review / Quality
   *  review / Diff review). The implementer call sets this from
   *  task-runner; reviewer call sites set it on the input. */
  bus?: import('../events/event-emitter.js').EventEmitter;
  batchId?: string;
  tier?: string;
  stageLabel?: string;
}

export interface ReviewerCallResult extends ReviewerParseResult {
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null };
}

export interface ReviewerDiffCallResult extends ReviewerDiffParseResult {
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null };
}

export class ReviewerEngine {
  private parser = new ReviewerOutputParser();
  constructor(private builder: ReviewerPromptBuilder) {}

  async runSpec(shell: RunnerShell, input: ReviewerInput): Promise<ReviewerCallResult> {
    const { systemPrompt, userPrompt } = this.builder.buildSpec({ ...input });
    const result = await shell.run({
      systemPrompt, userMessage: userPrompt, toolDefinitions: [],
      maxTurns: 5, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
    });
    const parsed = this.parser.parse(result.finalAssistantText ?? '');
    return { ...parsed, cost: extractCost(result) };
  }

  async runQualityAP(shell: RunnerShell, input: ReviewerInput): Promise<ReviewerCallResult> {
    const { systemPrompt, userPrompt } = this.builder.buildQualityAP({ ...input });
    const result = await shell.run({
      systemPrompt, userMessage: userPrompt, toolDefinitions: [],
      maxTurns: 5, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
    });
    const parsed = this.parser.parse(result.finalAssistantText ?? '');
    return { ...parsed, cost: extractCost(result) };
  }

  async runDiff(shell: RunnerShell, input: ReviewerInput): Promise<ReviewerDiffCallResult> {
    const { systemPrompt, userPrompt } = this.builder.buildDiff({ ...input });
    const result = await shell.run({
      systemPrompt, userMessage: userPrompt, toolDefinitions: [],
      maxTurns: 5, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
    });
    const parsed = this.parser.parseDiff(result.finalAssistantText ?? '');
    return { ...parsed, cost: extractCost(result) };
  }
}

function extractCost(r: { usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number | null }; turns?: number; toolCalls?: unknown[]; cost?: { costUSD?: number | null } }): ReviewerCallResult['cost'] {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: r.toolCalls?.length ?? 0,
    costUSD: r.cost?.costUSD ?? r.usage?.costUSD ?? null,
  };
}

export { ReviewerParseError };
