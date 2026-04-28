import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildSpecReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import type { SkippedReviewResult } from './skipped-result.js';

export interface SpecReviewResult {
  status: 'approved' | 'changes_required' | 'error' | 'api_error' | 'network_error' | 'timeout';
  report?: ParsedStructuredReport;
  findings: string[];
  errorReason?: string;
  reason?: string;
}

export type SpecReviewOrSkipped = SpecReviewResult | SkippedReviewResult;

export async function runSpecReview(
  reviewerProvider: Provider,
  packet: { prompt: string; scope: string[]; doneCondition: string },
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
  planContext?: string,
  evidenceBlock?: string,
  taskDeadlineMs?: number,
  abortSignal?: AbortSignal,
  onProgress?: (e: import('../runners/types.js').InternalRunnerEvent) => void,
): Promise<SpecReviewResult> {
  const prompt = (evidenceBlock ? `${evidenceBlock}\n\n` : '') +
    buildSpecReviewPrompt(packet, implReport, fileContents, toolCallLog, planContext);

  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';
  const delegateOpts = { explicitlyPinned: true as const, taskDeadlineMs, abortSignal, onProgress };
  let result;
  try {
    result = await delegateWithEscalation(
      {
        prompt,
        agentType: reviewerSlot,
        briefQualityPolicy: 'off',
        timeoutMs: 120_000,
      },
      [reviewerProvider],
      delegateOpts,
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

  // Design note: we only check summary presence, not full structured format.
  // After Task 2's lenient parsing, most reviewer outputs will parse successfully — that's the goal.
  // The retry is a safety net for truly empty/garbage responses, not a format enforcer.
  // If the reviewer says "Approved" in plain text, lenient parsing accepts it. That's correct.
  let report = parseStructuredReport(result.output);
  if (!report.summary) {
    // Retry once with stronger format instruction
    try {
      const retryResult = await delegateWithEscalation(
        {
          prompt: prompt + '\n\nIMPORTANT: Your response MUST begin with a "## Summary" section containing either "approved" or "changes_required". Follow this exact format.',
          agentType: reviewerSlot,
          briefQualityPolicy: 'off',
          timeoutMs: 120_000,
        },
        [reviewerProvider],
        delegateOpts,
      );
      if (retryResult.status === 'ok') {
        report = parseStructuredReport(retryResult.output);
      }
    } catch { /* fall through to error */ }

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
