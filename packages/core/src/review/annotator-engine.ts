import type { RunnerShell } from '../providers/runner-shell.js';
import { AnnotatorPromptBuilder, type AnnotatorRoute } from './annotator-prompt-builder.js';
import { AnnotatorOutputParser, type AnnotatorParseResult } from './annotator-output-parser.js';
import { annotatorAuditTemplate } from './templates/annotator-audit.js';
import { annotatorReviewTemplate } from './templates/annotator-review.js';
import { annotatorVerifyTemplate } from './templates/annotator-verify.js';
import { annotatorDebugTemplate } from './templates/annotator-debug.js';
import { annotatorInvestigateTemplate } from './templates/annotator-investigate.js';
import { SAFETY_MAX_TURNS } from '../bounded-execution/safety-max-turns.js';

const DEFAULT_ANNOTATOR_TEMPLATES = {
  audit: annotatorAuditTemplate,
  review: annotatorReviewTemplate,
  verify: annotatorVerifyTemplate,
  debug: annotatorDebugTemplate,
  investigate: annotatorInvestigateTemplate,
} as const;

export interface AnnotatorInput {
  /** N parallel sub-worker narratives, one per criterion the dispatcher
   *  fanned out. With N=1 the engine behaves as a single-narrative
   *  annotator (legacy compatibility for any non-fan-out caller). */
  workerOutputs: Array<{ criterion: string; narrative: string }>;
  brief: string;
  cwd: string;
  route: AnnotatorRoute;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  /** Forwarded to RunInput so the running-headline sink + verbose stderr
   *  show stage="Annotating" while the read-only review pass runs. */
  bus?: import('../events/event-emitter.js').EventEmitter;
  batchId?: string;
  taskIndex?: number;
  tier?: string;
  stageLabel?: string;
}

/** Sentinel narrative emitted by sub-workers when their criterion has no
 *  matches in the artifact. Filtered out before merging so the annotator
 *  doesn't waste tokens parsing empty content. */
const NO_FINDINGS_SENTINEL = 'No findings for this criterion.';

export interface AnnotatorCallResult extends AnnotatorParseResult {
  /** Raw assistant text from the shell run — per-tool compose_response handlers
   *  parse this via their per-tool report schema (audit, review, verify each
   *  have their own shape that does not match AnnotatedFinding). */
  finalAssistantText: string;
  cost: { inputTokens: number; outputTokens: number; turnCount: number; toolCallCount: number; costUSD: number | null; durationMs: number | null };
}

export class AnnotatorEngine {
  private builder = new AnnotatorPromptBuilder(DEFAULT_ANNOTATOR_TEMPLATES);
  private parser = new AnnotatorOutputParser();

  async annotate(shell: RunnerShell, input: AnnotatorInput): Promise<AnnotatorCallResult> {
    // Drop "No findings for this criterion." sentinels — they're valid
    // empty results, not findings to merge. If ALL narratives are empty
    // sentinels, send a synthetic empty narrative so the annotator
    // returns []  via its standard "no findings raised" path.
    const usableOutputs = input.workerOutputs.filter(
      o => o.narrative.trim() !== NO_FINDINGS_SENTINEL,
    );
    const inputsForPrompt = usableOutputs.length > 0
      ? usableOutputs
      : [{ criterion: 'all sub-workers reported no findings', narrative: '(all sub-worker narratives were "No findings for this criterion." — return [])' }];
    const prompt = this.builder.build(input.route, { workerOutputs: inputsForPrompt, brief: input.brief });
    const result = await shell.run({
      systemPrompt: prompt,
      userMessage: 'Annotate the findings above.',
      toolDefinitions: [],
      maxTurns: SAFETY_MAX_TURNS, cwd: input.cwd,
      abortSignal: input.abortSignal, deadlineMs: input.deadlineMs,
      ...(input.bus && { bus: input.bus }),
      ...(input.batchId !== undefined && { batchId: input.batchId }),
      ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
      ...(input.tier !== undefined && { tier: input.tier }),
      ...(input.stageLabel !== undefined && { stageLabel: input.stageLabel }),
    });
    const parsed = this.parser.parse({ finalAssistantText: result.finalAssistantText, errorCode: result.errorCode });
    return { ...parsed, finalAssistantText: result.finalAssistantText ?? '', cost: extractCost(result) };
  }
}

function extractCost(r: { usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number | null }; turns?: number; toolCalls?: unknown[]; cost?: { costUSD?: number | null }; costUSD?: number | null; durationMs?: number | null }): AnnotatorCallResult['cost'] {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: r.toolCalls?.length ?? 0,
    costUSD: r.costUSD ?? r.cost?.costUSD ?? r.usage?.costUSD ?? null,
    durationMs: r.durationMs ?? null,
  };
}
