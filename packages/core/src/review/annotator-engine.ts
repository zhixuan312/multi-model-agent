import type { Session } from '../types/run-result.js';
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

  async annotate(session: Session, input: AnnotatorInput): Promise<AnnotatorCallResult> {
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

    // Per-annotator wall-clock guard. Same 10-min hard / 5-min soft pattern
    // as the warmer + per-angle caps so the merge step can't hang the route.
    // On hard cap, the abortSignal fires and the merge result returns with
    // errorCode='aborted'; the parser then yields an empty findings list and
    // the read-only route's soft-success path takes over (lifecycle returns
    // implementer narratives even when annotator failed). Bounds total
    // route wall: warmer (≤10) + max angle (≤10) + merge (≤10) + slack ≈ 32 min.
    const annotatorAbort = new AbortController();
    const combinedAbort = new AbortController();
    if (input.abortSignal) {
      if (input.abortSignal.aborted) combinedAbort.abort();
      else input.abortSignal.addEventListener('abort', () => combinedAbort.abort(), { once: true });
    }
    annotatorAbort.signal.addEventListener('abort', () => combinedAbort.abort(), { once: true });
    let capHit = false;
    const softTimer = setTimeout(() => {
      input.bus?.emit({
        event: 'criteria_annotator_soft_warning',
        ts: new Date().toISOString(),
        ...(input.batchId !== undefined && { batchId: input.batchId }),
        ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
        elapsedMs: ANNOTATOR_SOFT_WARN_MS,
        remainingMs: ANNOTATOR_HARD_CAP_MS - ANNOTATOR_SOFT_WARN_MS,
      });
    }, ANNOTATOR_SOFT_WARN_MS);
    const hardTimer = setTimeout(() => {
      capHit = true;
      input.bus?.emit({
        event: 'criteria_annotator_hard_cap',
        ts: new Date().toISOString(),
        ...(input.batchId !== undefined && { batchId: input.batchId }),
        ...(input.taskIndex !== undefined && { taskIndex: input.taskIndex }),
        elapsedMs: ANNOTATOR_HARD_CAP_MS,
      });
      annotatorAbort.abort();
    }, ANNOTATOR_HARD_CAP_MS);

    try {
      const turn = await session.send(
        `${prompt}\n\nAnnotate the findings above.`,
        { stageLabel: input.stageLabel ?? 'Annotating' },
      );
      // Adapt TurnResult → the shape this engine's parser + cost
      // extractor uses.
      const result = {
        finalAssistantText: turn.output,
        errorCode: turn.errorCode,
        usage: turn.usage,
        turns: turn.turns,
        toolCalls: Object.values(turn.toolCallsByName).reduce((a, b) => a + b, 0),
        costUSD: turn.costUSD,
        durationMs: turn.durationMs,
      };
      if (capHit) {
        return {
          finalAssistantText: '',
          verdict: 'error',
          annotatedFindings: [],
          concerns: [],
          diagnostics: { extraSections: {} },
          cost: extractCost(result),
        } as unknown as AnnotatorCallResult;
      }
      const parsed = this.parser.parse({ finalAssistantText: result.finalAssistantText, errorCode: result.errorCode });
      return { ...parsed, finalAssistantText: result.finalAssistantText ?? '', cost: extractCost(result) };
    } finally {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    }
  }
}

/** Per-annotator wall-clock cap. Same constants as the warmer + per-angle
 *  caps in providers/runner-shell.ts and lifecycle/parallel-criteria-dispatcher.ts. */
const ANNOTATOR_HARD_CAP_MS = 10 * 60 * 1000;
const ANNOTATOR_SOFT_WARN_MS = 5 * 60 * 1000;

function extractCost(r: { usage?: { inputTokens?: number; outputTokens?: number }; turns?: number; toolCalls?: number; costUSD?: number | null; durationMs?: number | null }): AnnotatorCallResult['cost'] {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: typeof r.toolCalls === 'number' ? r.toolCalls : 0,
    costUSD: r.costUSD ?? null,
    durationMs: r.durationMs ?? null,
  };
}
