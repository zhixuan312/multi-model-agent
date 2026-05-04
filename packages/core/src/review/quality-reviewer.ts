import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildQualityReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import type { AnnotatedFinding } from '../executors/_shared/findings-schema.js';
import { parseReviewerFindings, type ParseReviewerFindingsResult } from './parse-reviewer-findings.js';
import { fallbackExtractFindings } from './fallback-extraction.js';

export { parseReviewerFindings, type ParseReviewerFindingsResult } from './parse-reviewer-findings.js';
export { fallbackExtractFindings } from './fallback-extraction.js';

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
  status: 'approved' | 'changes_required' | 'annotated' | 'error' | 'api_error' | 'network_error' | 'timeout' | 'api_aborted' | 'skipped';
  annotatedFindings?: AnnotatedFinding[];
  report?: ParsedStructuredReport;
  findings: string[];
  errorReason?: string;
  reason?: string;
  /** Per-stage telemetry metrics from the review provider call. */
  metrics?: QualityReviewMetrics;
}

export interface QualityReviewMetrics {
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  toolCallCount: number;
  /**
   * Item 7: null means "pricing unavailable / unknown" (provider returned null
   * costUSD, e.g., model has no pricing in profile). 0 means "free or zero-cost".
   * endReviewStage falls back to runningCostUSD-c0 when this is null.
   */
  costUSD: number | null;
}

export function extractMetrics(r: { usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number | null }; turns?: number; toolCalls?: unknown[] }): QualityReviewMetrics {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: r.toolCalls?.length ?? 0,
    costUSD: r.usage?.costUSD ?? null,
  };
}

function addMetrics(a: QualityReviewMetrics, b: QualityReviewMetrics): QualityReviewMetrics {
  // Item 7: null means unknown. Sum is null only if BOTH are null;
  // (null + known) = known (preserve the partial signal). This keeps
  // running cost tracking working when one iteration has unknown cost.
  const addNullable = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    turnCount: a.turnCount + b.turnCount,
    toolCallCount: a.toolCallCount + b.toolCallCount,
    costUSD: addNullable(a.costUSD, b.costUSD),
  };
}

/** Backward-compat alias kept until reviewed-lifecycle is migrated to the new shape (Task 6). */
export type LegacyQualityReviewResult = QualityReviewResult;

/**
 * Like fallbackExtractFindings but suppresses the synthetic single
 * "reviewer parse failed; deterministic fallback emitted single catch-all"
 * finding. The transport-failure salvage path needs this stricter contract:
 * we want REAL structured findings from the implementer's numbered narrative,
 * not a fabricated catch-all just because the LLM never responded. Returning
 * [] here means the caller leaves `annotatedFindings` undefined on the
 * envelope, preserving the pre-3.12.5 contract for read-only routes whose
 * implementer didn't produce numbered narrative content.
 *
 * The synthetic catch-all is identifiable by its claim string (matches
 * fallbackExtractFindings's no-sections branch verbatim).
 */
function realFindingsFromWorker(workerOutput: string): AnnotatedFinding[] {
  const findings = fallbackExtractFindings(workerOutput);
  if (findings.length === 1 && findings[0]!.claim.startsWith('reviewer parse failed')) {
    return [];
  }
  return findings;
}

export async function runQualityReview(
  reviewerProvider: Provider,
  packet: { prompt: string; scope: string[]; doneCondition: string },
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
  filesWritten: string[],
  evidenceBlock?: string,
  qualityReviewPromptBuilder?: (ctx: { workerOutput: string; brief: string }) => string,
  workerOutput?: string,
  taskDeadlineMs?: number,
  abortSignal?: AbortSignal,
  onProgress?: (e: import('../runners/types.js').InternalRunnerEvent) => void,
  cwd: string = process.cwd(),
): Promise<QualityReviewResult> {
  // Read-only annotation path: triggered when caller passed a prompt builder
  // (these are the per-route quality_only prompts in quality-only-prompts.ts).
  if (qualityReviewPromptBuilder && workerOutput !== undefined) {
    return runAnnotationReview(reviewerProvider, packet, workerOutput, qualityReviewPromptBuilder, cwd, taskDeadlineMs, abortSignal, onProgress);
  }

  // Artifact-route gating path: unchanged from prior behavior.
  if (filesWritten.length === 0) {
    return { status: 'skipped', findings: [], errorReason: 'no files written by implementer' };
  }

  const coreParts = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
  const fullPrompt = (evidenceBlock ? `${evidenceBlock}\n\n` : '') +
    `${coreParts.systemPrefix}\n\n${coreParts.userBody}`;
  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';
  let metrics: QualityReviewMetrics = { inputTokens: 0, outputTokens: 0, turnCount: 0, toolCallCount: 0, costUSD: 0 };
  let result;
  try {
    result = await delegateWithEscalation(
      { prompt: fullPrompt, cwd, agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000 },
      [reviewerProvider],
      { explicitlyPinned: true, taskDeadlineMs, abortSignal, onProgress },
    );
    metrics = extractMetrics(result);
  } catch (err) {
    return { status: 'error', findings: [], errorReason: `review agent threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.status !== 'ok') {
    if (result.status === 'api_error' || result.status === 'network_error' || result.status === 'timeout' || result.status === 'api_aborted') {
      return { status: result.status, findings: [], errorReason: `review agent returned status: ${result.status}` };
    }
    return { status: 'error', findings: [], errorReason: `review agent returned status: ${result.status}`, metrics };
  }

  let report = parseStructuredReport(result.output);
  if (!report.summary) {
    try {
      const retryResult = await delegateWithEscalation(
        {
          prompt: fullPrompt + '\n\nIMPORTANT: Your response MUST begin with a "## Summary" section containing either "approved" or "changes_required". Follow this exact format.',
          cwd, agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000,
        },
        [reviewerProvider],
        { explicitlyPinned: true, taskDeadlineMs, abortSignal, onProgress },
      );
      metrics = addMetrics(metrics, extractMetrics(retryResult));
      if (retryResult.status === 'ok') report = parseStructuredReport(retryResult.output);
    } catch { /* fall through */ }

    if (!report.summary) {
      return { status: 'error', findings: [], errorReason: 'reviewer output missing ## Summary section (after retry)', metrics };
    }
  }

  const summaryLower = report.summary.toLowerCase();
  if (summaryLower.includes('changes_required')) {
    return {
      status: 'changes_required',
      report,
      findings: [...(report.deviationsFromBrief ?? []), ...(report.unresolved ?? [])],
      metrics,
    };
  }
  return { status: 'approved', report, findings: [], metrics };
}

async function runAnnotationReview(
  reviewerProvider: Provider,
  packet: { prompt: string; scope: string[]; doneCondition: string },
  workerOutput: string,
  qualityReviewPromptBuilder: (ctx: { workerOutput: string; brief: string }) => string,
  cwd: string,
  taskDeadlineMs?: number,
  abortSignal?: AbortSignal,
  onProgress?: (e: import('../runners/types.js').InternalRunnerEvent) => void,
): Promise<QualityReviewResult> {
  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';

  const basePrompt = qualityReviewPromptBuilder({ workerOutput, brief: packet.prompt });
  let metrics: QualityReviewMetrics = { inputTokens: 0, outputTokens: 0, turnCount: 0, toolCallCount: 0, costUSD: 0 };

  // Attempt 1
  const attempt1 = await callReviewer(basePrompt);
  if (attempt1.kind === 'transport') {
    // 3.12.5: even when the LLM reviewer transport-fails, run the deterministic
    // narrative extractor on the worker output so AnnotatedFindings carry
    // real findings into the dashboard's findingsBySeverity rollup. The
    // transport status (error/timeout/api_error/network_error/api_aborted)
    // is preserved so operators still see the outage in `verdict`/`errorReason`,
    // but the implementer's structured narrative isn't lost just because the
    // reviewer's annotator pass couldn't run. Pre-3.12.5 returned empty
    // findings here, masking ~50+ real audit findings in 3.12.4 telemetry.
    const salvage = realFindingsFromWorker(workerOutput);
    return {
      status: attempt1.status,
      findings: [],
      ...(salvage.length > 0 ? { annotatedFindings: salvage } : {}),
      errorReason: attempt1.errorReason,
      metrics: attempt1.metrics,
    };
  }
  metrics = addMetrics(metrics, attempt1.metrics);

  let parsed1: ParseReviewerFindingsResult;
  if (attempt1.parsedFindings !== null) {
    parsed1 = { ok: true, findings: attempt1.parsedFindings, ungroundedCount: attempt1.parsedFindings.filter(f => !f.evidenceGrounded).length };
  } else {
    parsed1 = parseReviewerFindings(attempt1.output, workerOutput);
  }
  if (parsed1.ok) {
    return successResult(parsed1.findings, metrics);
  }

  // Attempt 2 — strict reminder
  const reminderPrompt = `${basePrompt}\n\nIMPORTANT: Your previous response was not parseable (${parsed1.reason}). Emit ONLY the findings JSON array now, in a single \`\`\`json fenced code block as the LAST block in your response. No surrounding prose required.`;
  const attempt2 = await callReviewer(reminderPrompt);
  if (attempt2.kind === 'transport') {
    // 3.12.5: same salvage-on-transport-failure as attempt1 above. Status
    // still propagates the transport error so operators see the outage,
    // but findings from the implementer's narrative are not discarded.
    metrics = addMetrics(metrics, attempt2.metrics);
    const salvage = realFindingsFromWorker(workerOutput);
    return {
      status: attempt2.status,
      findings: [],
      ...(salvage.length > 0 ? { annotatedFindings: salvage } : {}),
      errorReason: attempt2.errorReason,
      metrics,
    };
  }
  metrics = addMetrics(metrics, attempt2.metrics);

  let parsed2: ParseReviewerFindingsResult;
  if (attempt2.parsedFindings !== null) {
    parsed2 = { ok: true, findings: attempt2.parsedFindings, ungroundedCount: attempt2.parsedFindings.filter(f => !f.evidenceGrounded).length };
  } else {
    parsed2 = parseReviewerFindings(attempt2.output, workerOutput);
  }
  if (parsed2.ok) {
    return successResult(parsed2.findings, metrics);
  }

  // Both LLM attempts failed parse — deterministic fallback. Verdict stays
  // 'annotated' so telemetry never sees 'error' from a parseable worker output.
  const fallback = fallbackExtractFindings(workerOutput);
  return successResult(fallback, metrics);

  // ── helpers ────────────────────────────────────────────────────────────

  function successResult(findings: AnnotatedFinding[], m: QualityReviewMetrics): QualityReviewResult {
    return {
      status: 'annotated',
      annotatedFindings: findings,
      findings: [],
      metrics: m,
    };
  }

  type CallOk = {
    kind: 'ok';
    output: string;
    metrics: QualityReviewMetrics;
    /** Threaded through from RunResult.parsedFindings. Non-null only on OpenAI
     *  review-mode runs (Edit G2). Null on Claude/Codex (which still use
     *  parseReviewerFindings). */
    parsedFindings: AnnotatedFinding[] | null;
  };
  type CallTransport = { kind: 'transport'; status: 'error' | 'api_error' | 'network_error' | 'timeout' | 'api_aborted'; errorReason: string; metrics: QualityReviewMetrics };

  async function callReviewer(prompt: string): Promise<CallOk | CallTransport> {
    let result;
    try {
      result = await delegateWithEscalation(
        { prompt, cwd, agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000 },
        [reviewerProvider],
        { explicitlyPinned: true, taskDeadlineMs, abortSignal, onProgress },
      );
    } catch (err) {
      return { kind: 'transport', status: 'error', errorReason: `review agent threw: ${err instanceof Error ? err.message : String(err)}`, metrics: { inputTokens: 0, outputTokens: 0, turnCount: 0, toolCallCount: 0, costUSD: 0 } };
    }
    const m = extractMetrics(result);
    if (result.status !== 'ok') {
      if (result.status === 'api_error' || result.status === 'network_error' || result.status === 'timeout' || result.status === 'api_aborted') {
        return { kind: 'transport', status: result.status, errorReason: `review agent returned status: ${result.status}`, metrics: m };
      }
      return { kind: 'transport', status: 'error', errorReason: `review agent returned status: ${result.status}`, metrics: m };
    }
    return { kind: 'ok', output: result.output, metrics: m, parsedFindings: result.parsedFindings ?? null };
  }
}
