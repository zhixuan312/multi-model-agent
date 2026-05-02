import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildQualityReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import type { AnnotatedFinding } from '../executors/_shared/findings-schema.js';
import { parseReviewerFindings } from './parse-reviewer-findings.js';
import { fallbackExtractFindings } from './fallback-extraction.js';

export { parseReviewerFindings } from './parse-reviewer-findings.js';
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
  costUSD: number;
}

function extractMetrics(r: { usage?: { inputTokens?: number; outputTokens?: number; costUSD?: number | null }; turns?: number; toolCalls?: unknown[] }): QualityReviewMetrics {
  return {
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    turnCount: r.turns ?? 0,
    toolCallCount: r.toolCalls?.length ?? 0,
    costUSD: r.usage?.costUSD ?? 0,
  };
}

function addMetrics(a: QualityReviewMetrics, b: QualityReviewMetrics): QualityReviewMetrics {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    turnCount: a.turnCount + b.turnCount,
    toolCallCount: a.toolCallCount + b.toolCallCount,
    costUSD: a.costUSD + b.costUSD,
  };
}

/** Backward-compat alias kept until reviewed-lifecycle is migrated to the new shape (Task 6). */
export type LegacyQualityReviewResult = QualityReviewResult;

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

  const corePrompt = buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
  const prompt = (evidenceBlock ? `${evidenceBlock}\n\n` : '') + corePrompt;
  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';
  let metrics: QualityReviewMetrics = { inputTokens: 0, outputTokens: 0, turnCount: 0, toolCallCount: 0, costUSD: 0 };
  let result;
  try {
    result = await delegateWithEscalation(
      { prompt, cwd, agentType: reviewerSlot, briefQualityPolicy: 'off', timeoutMs: 120_000 },
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
          prompt: prompt + '\n\nIMPORTANT: Your response MUST begin with a "## Summary" section containing either "approved" or "changes_required". Follow this exact format.',
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
    return { status: attempt1.status, findings: [], errorReason: attempt1.errorReason, metrics: attempt1.metrics };
  }
  metrics = addMetrics(metrics, attempt1.metrics);
  const parsed1 = parseReviewerFindings(attempt1.output, workerOutput);
  if (parsed1.ok) {
    return successResult(parsed1.findings, metrics);
  }

  // Attempt 2 — strict reminder
  const reminderPrompt = `${basePrompt}\n\nIMPORTANT: Your previous response was not parseable (${parsed1.reason}). Emit ONLY the findings JSON array now, in a single \`\`\`json fenced code block as the LAST block in your response. No surrounding prose required.`;
  const attempt2 = await callReviewer(reminderPrompt);
  // Round-2 finding #1: transport failure on retry MUST propagate as error, not
  // silently fall back. Fallback is for parse failure of a real response,
  // never for infrastructure failure. Otherwise telemetry hides outages.
  if (attempt2.kind === 'transport') {
    metrics = addMetrics(metrics, attempt2.metrics);
    return { status: attempt2.status, findings: [], errorReason: attempt2.errorReason, metrics };
  }
  metrics = addMetrics(metrics, attempt2.metrics);
  const parsed2 = parseReviewerFindings(attempt2.output, workerOutput);
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

  type CallOk = { kind: 'ok'; output: string; metrics: QualityReviewMetrics };
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
    return { kind: 'ok', output: result.output, metrics: m };
  }
}
