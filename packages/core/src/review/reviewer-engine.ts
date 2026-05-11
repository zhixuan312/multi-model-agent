import type { RunnerShell } from '../providers/runner-shell.js';
import { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
import { ReviewerOutputParser, type ReviewerParseResult, type ReviewerDiffParseResult, ReviewerParseError } from './reviewer-output-parser.js';
import { SAFETY_MAX_TURNS } from '../bounded-execution/safety-max-turns.js';

// Re-exports for callers. Spec C11 puts templates in review/templates/ and
// the builder in review/reviewer-prompt-builder.ts; the re-exports keep one
// import surface for the engine + its collaborators.
//
// Pipeline-redesign (4.3.0+): the AP-only templates (specTemplate,
// qualityAPTemplate, diffTemplate) were removed along with their consumer
// handlers (spec-chain, quality-chain, review-diff). New review-and-fix
// templates replace them for the artifact-producing pipeline.
export type { ReviewTemplate } from './templates/shared.js';
export { specReviewAndFixTemplate } from './templates/spec-review-and-fix.js';
export { qualityReviewAndFixTemplate } from './templates/quality-review-and-fix.js';
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
  /**
   * Cumulative unified diff of every change made since task start.
   * Tool sweep #6: reviewer prompts include this so the LLM can
   * judge work against actual code changes, not the worker's text
   * claim. Empty when no files changed (or read-only routes).
   */
  diff?: string;
  /**
   * Concrete concerns raised by previous reviewer rounds in this
   * chain (round 1 = empty, round N+1 = concerns from round 1..N).
   * Lets the reviewer verify the rework addressed prior issues
   * without re-deriving them.
   */
  priorConcerns?: string[];
  /**
   * Verbatim plan section for execute-plan routes. Set by the
   * spec-chain handler from `task.planContext`; threaded into the
   * spec reviewer's user prompt as the authoritative source-of-truth
   * for verbatim-code-block comparison. Unset for non-execute-plan
   * routes — those routes have no "plan" to compare against.
   */
  planContext?: string;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  /** Forwarded to RunInput so the running-headline sink + verbose stderr
   *  show which lifecycle stage the model is in (Spec review / Quality
   *  review / Diff review). The implementer call sets this from
   *  task-runner; reviewer call sites set it on the input. */
  bus?: import('../events/event-emitter.js').EventEmitter;
  batchId?: string;
  taskIndex?: number;
  tier?: string;
  stageLabel?: string;
}

export interface ReviewerCallResult extends ReviewerParseResult {
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null; durationMs: number | null };
}

export interface ReviewerDiffCallResult extends ReviewerDiffParseResult {
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null; durationMs: number | null };
}

export class ReviewerEngine {
  private parser = new ReviewerOutputParser();
  constructor(private builder: ReviewerPromptBuilder) {}

  async runSpec(shell: RunnerShell, input: ReviewerInput): Promise<ReviewerCallResult> {
    const { systemPrompt, userPrompt } = this.builder.buildSpec({ ...input });
    const result = await shell.run({
      systemPrompt, userMessage: userPrompt, toolDefinitions: [],
      maxTurns: SAFETY_MAX_TURNS, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
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
      maxTurns: SAFETY_MAX_TURNS, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
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
      maxTurns: SAFETY_MAX_TURNS, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
    });
    const parsed = this.parser.parseDiff(result.finalAssistantText ?? '');
    return { ...parsed, cost: extractCost(result) };
  }
}

function extractCost(r: { usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number | null }; turns?: number; toolCalls?: unknown[]; cost?: { costUSD?: number | null }; costUSD?: number | null; durationMs?: number | null }): ReviewerCallResult['cost'] {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: r.toolCalls?.length ?? 0,
    // shell.run now exposes top-level costUSD; legacy paths used cost.costUSD or usage.costUSD.
    costUSD: r.costUSD ?? r.cost?.costUSD ?? r.usage?.costUSD ?? null,
    durationMs: r.durationMs ?? null,
  };
}

export { ReviewerParseError };
