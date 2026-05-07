import type { RunnerShell } from '../providers/runner-shell.js';
import { AnnotatorPromptBuilder, type AnnotatorRoute } from './annotator-prompt-builder.js';
import { AnnotatorOutputParser, type AnnotatorParseResult } from './annotator-output-parser.js';
import { annotatorAuditTemplate } from './templates/annotator-audit.js';
import { annotatorReviewTemplate } from './templates/annotator-review.js';
import { annotatorVerifyTemplate } from './templates/annotator-verify.js';
import { annotatorDebugTemplate } from './templates/annotator-debug.js';
import { annotatorInvestigateTemplate } from './templates/annotator-investigate.js';

const DEFAULT_ANNOTATOR_TEMPLATES = {
  audit: annotatorAuditTemplate,
  review: annotatorReviewTemplate,
  verify: annotatorVerifyTemplate,
  debug: annotatorDebugTemplate,
  investigate: annotatorInvestigateTemplate,
} as const;

export interface AnnotatorInput {
  workerOutput: string;
  brief: string;
  cwd: string;
  route: AnnotatorRoute;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
}

export interface AnnotatorCallResult extends AnnotatorParseResult {
  /** Raw assistant text from the shell run — per-tool compose_response handlers
   *  parse this via their per-tool report schema (audit, review, verify each
   *  have their own shape that does not match AnnotatedFinding). */
  finalAssistantText: string;
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null };
}

export class AnnotatorEngine {
  private builder = new AnnotatorPromptBuilder(DEFAULT_ANNOTATOR_TEMPLATES);
  private parser = new AnnotatorOutputParser();

  async annotate(shell: RunnerShell, input: AnnotatorInput): Promise<AnnotatorCallResult> {
    const prompt = this.builder.build(input.route, { workerOutput: input.workerOutput, brief: input.brief });
    const result = await shell.run({
      systemPrompt: prompt,
      userMessage: 'Annotate the findings above.',
      toolDefinitions: [],
      maxTurns: 5, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
    });
    const parsed = this.parser.parse({ finalAssistantText: result.finalAssistantText, errorCode: result.errorCode });
    return { ...parsed, finalAssistantText: result.finalAssistantText ?? '', cost: extractCost(result) };
  }
}

function extractCost(r: { usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number | null }; turns?: number; toolCalls?: unknown[]; cost?: { costUSD?: number | null } }): AnnotatorCallResult['cost'] {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: r.toolCalls?.length ?? 0,
    costUSD: r.cost?.costUSD ?? r.usage?.costUSD ?? null,
  };
}
