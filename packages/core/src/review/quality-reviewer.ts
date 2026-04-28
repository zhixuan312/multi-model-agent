import { z } from 'zod';
import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildQualityReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import {
  workerFindingsSchema,
  type WorkerFinding,
  type AnnotatedFinding,
} from '../executors/_shared/findings-schema.js';

/**
 * Result of the read-only annotation review pass.
 * - 'annotated' — reviewer ran, every worker finding has reviewerConfidence (and optionally reviewerSeverity).
 * - 'error' — reviewer crashed, output unparseable, or id-set mismatch with worker.
 * - 'skipped' — kill switch, no provider, or worker emitted no findings (nothing to annotate).
 *
 * The legacy gating-style fields (`findings: string[]`, `report: ParsedStructuredReport`) are kept
 * on the result for the artifact-route path which still uses the gating model.
 */
/**
 * Unified quality-review result. The status discriminates which fields are
 * meaningful; consumers read either `annotatedFindings` (annotation path) or
 * `findings` + `report` (gating path).
 *
 * - 'annotated' — read-only annotation path; populated `annotatedFindings`.
 * - 'approved' / 'changes_required' — artifact-route gating path; `findings` +
 *   `report` carry the gating signal.
 * - 'error' / 'api_error' / 'network_error' / 'timeout' — review failed.
 * - 'skipped' — kill switch, no provider, or worker emitted no findings.
 */
export interface QualityReviewResult {
  status: 'approved' | 'changes_required' | 'annotated' | 'error' | 'api_error' | 'network_error' | 'timeout' | 'skipped';
  annotatedFindings?: AnnotatedFinding[];
  report?: ParsedStructuredReport;
  findings: string[];
  errorReason?: string;
  reason?: string;
}

/** Backward-compat alias kept until reviewed-lifecycle is migrated to the new shape (Task 6). */
export type LegacyQualityReviewResult = QualityReviewResult;

const annotationItemSchema = z.object({
  id: z.string().min(1),
  reviewerConfidence: z.number().int().min(0).max(100),
  reviewerSeverity: z.enum(['high', 'medium', 'low']).optional(),
}).strict();

const annotationsArraySchema = z.array(annotationItemSchema);

/**
 * Extract the first ```json fenced code block from a string, or `null` if none found.
 */
function extractJsonBlock(output: string): string | null {
  const match = output.match(/```json\s*\n([\s\S]*?)\n```/);
  return match ? match[1] : null;
}

/**
 * Parse worker findings from the worker's raw output. Looks for a ```json block whose
 * content is an array passing workerFindingsSchema. Returns null if absent or invalid.
 */
export function extractWorkerFindings(workerOutput: string): WorkerFinding[] | null {
  // Try the first json block; if absent, also try matching multiple blocks for
  // resilience against workers that emit example JSON before the real findings.
  const blocks = [...workerOutput.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(m => m[1]);
  for (const raw of blocks) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const validated = workerFindingsSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch { /* try next block */ }
  }
  return null;
}

interface AnnotationParseOk {
  ok: true;
  annotated: AnnotatedFinding[];
}
interface AnnotationParseErr {
  ok: false;
  reason: string;
}

/**
 * Parse the reviewer's response, validate against the worker's findings,
 * and merge to produce AnnotatedFinding[].
 *
 * Validation:
 * - Reviewer output must contain exactly one ```json fenced block (we take the first).
 * - Block content must be a JSON array passing annotationsArraySchema.
 * - Annotation ids must be a permutation of worker ids: no missing, no duplicate, no extra.
 */
export function parseAndMergeAnnotations(
  reviewerOutput: string,
  workerFindings: WorkerFinding[],
): AnnotationParseOk | AnnotationParseErr {
  const block = extractJsonBlock(reviewerOutput);
  if (block === null) {
    return { ok: false, reason: 'reviewer output missing ```json fenced block' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    return { ok: false, reason: `reviewer JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const validated = annotationsArraySchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: `annotation array validation failed: ${validated.error.message}` };
  }
  const annotations = validated.data;

  const workerIds = new Set(workerFindings.map(f => f.id));
  const reviewerIds = annotations.map(a => a.id);
  const reviewerIdSet = new Set(reviewerIds);

  if (reviewerIds.length !== reviewerIdSet.size) {
    return { ok: false, reason: 'duplicate id in reviewer annotations' };
  }
  if (reviewerIdSet.size !== workerIds.size) {
    return { ok: false, reason: `annotation count ${reviewerIdSet.size} does not match worker findings count ${workerIds.size}` };
  }
  for (const id of reviewerIdSet) {
    if (!workerIds.has(id)) {
      return { ok: false, reason: `reviewer annotated unknown id: ${id}` };
    }
  }
  for (const id of workerIds) {
    if (!reviewerIdSet.has(id)) {
      return { ok: false, reason: `reviewer missing annotation for worker id: ${id}` };
    }
  }

  const byId = new Map(annotations.map(a => [a.id, a]));
  const merged: AnnotatedFinding[] = workerFindings.map(wf => {
    const ann = byId.get(wf.id)!;
    const out: AnnotatedFinding = {
      ...wf,
      reviewerConfidence: ann.reviewerConfidence,
    };
    if (ann.reviewerSeverity !== undefined) out.reviewerSeverity = ann.reviewerSeverity;
    return out;
  });
  return { ok: true, annotated: merged };
}

export async function runQualityReview(
  reviewerProvider: Provider,
  packet: { prompt: string; scope: string[]; doneCondition: string },
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
  filesWritten: string[],
  evidenceBlock?: string,
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string; workerFindings: WorkerFinding[] }) => string,
  workerOutput?: string,
): Promise<QualityReviewResult> {
  // Read-only annotation path: triggered when caller passed a prompt builder
  // (these are the per-route quality_only prompts in quality-only-prompts.ts).
  if (qualityReviewPromptBuilder && workerOutput !== undefined) {
    return runAnnotationReview(reviewerProvider, packet, workerOutput, qualityReviewPromptBuilder);
  }

  // Artifact-route gating path: unchanged from prior behavior.
  if (filesWritten.length === 0) {
    return { status: 'skipped', findings: [], errorReason: 'no files written by implementer' };
  }

  const corePrompt = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
  const prompt = (evidenceBlock ? `${evidenceBlock}\n\n` : '') + corePrompt;
  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';
  let result;
  try {
    result = await delegateWithEscalation(
      { prompt, agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000 },
      [reviewerProvider],
      { explicitlyPinned: true },
    );
  } catch (err) {
    return { status: 'error', findings: [], errorReason: `review agent threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.status !== 'ok') {
    if (result.status === 'api_error' || result.status === 'network_error' || result.status === 'timeout') {
      return { status: result.status, findings: [], errorReason: `review agent returned status: ${result.status}` };
    }
    return { status: 'error', findings: [], errorReason: `review agent returned status: ${result.status}` };
  }

  let report = parseStructuredReport(result.output);
  if (!report.summary) {
    try {
      const retryResult = await delegateWithEscalation(
        {
          prompt: prompt + '\n\nIMPORTANT: Your response MUST begin with a "## Summary" section containing either "approved" or "changes_required". Follow this exact format.',
          agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000,
        },
        [reviewerProvider],
        { explicitlyPinned: true },
      );
      if (retryResult.status === 'ok') report = parseStructuredReport(retryResult.output);
    } catch { /* fall through */ }

    if (!report.summary) {
      return { status: 'error', findings: [], errorReason: 'reviewer output missing ## Summary section (after retry)' };
    }
  }

  const summaryLower = report.summary.toLowerCase();
  if (summaryLower.includes('changes_required')) {
    return {
      status: 'changes_required',
      report,
      findings: [...(report.deviationsFromBrief ?? []), ...(report.unresolved ?? [])],
    };
  }
  return { status: 'approved', report, findings: [] };
}

async function runAnnotationReview(
  reviewerProvider: Provider,
  packet: { prompt: string; scope: string[]; doneCondition: string },
  workerOutput: string,
  qualityReviewPromptBuilder: (ctx: { workerOutput: string; brief: string; workerFindings: WorkerFinding[] }) => string,
): Promise<QualityReviewResult> {
  // Step 1: extract worker findings from worker output.
  const workerFindings = extractWorkerFindings(workerOutput);
  if (workerFindings === null) {
    return {
      status: 'error',
      findings: [],
      errorReason: 'worker output missing or invalid findings[] JSON block',
    };
  }

  // Step 2: short-circuit when worker found nothing — nothing to annotate.
  if (workerFindings.length === 0) {
    return {
      status: 'annotated',
      annotatedFindings: [],
      findings: [],
    };
  }

  // Step 3: build the route-specific prompt and call the reviewer.
  const prompt = qualityReviewPromptBuilder({ workerOutput, brief: packet.prompt, workerFindings });
  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';

  let result;
  try {
    result = await delegateWithEscalation(
      { prompt, agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000 },
      [reviewerProvider],
      { explicitlyPinned: true },
    );
  } catch (err) {
    return {
      status: 'error',
      findings: [],
      errorReason: `review agent threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.status !== 'ok') {
    return {
      status: 'error',
      findings: [],
      errorReason: `review agent returned status: ${result.status}`,
    };
  }

  // Step 4: parse + validate + merge annotations.
  const merged = parseAndMergeAnnotations(result.output, workerFindings);
  if (!merged.ok) {
    return { status: 'error', findings: [], errorReason: merged.reason };
  }

  return {
    status: 'annotated',
    annotatedFindings: merged.annotated,
    findings: [],
  };
}
