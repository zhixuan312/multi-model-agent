import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildQualityReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';

export interface QualityReviewResult {
  status: 'approved' | 'changes_required' | 'skipped' | 'error';
  report?: ParsedStructuredReport;
  findings: string[];
  errorReason?: string;
}

export async function runQualityReview(
  reviewerProvider: Provider,
  packet: { prompt: string; scope: string[]; doneCondition: string },
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
  filesWritten: string[],
): Promise<QualityReviewResult> {
  if (filesWritten.length === 0) {
    return { status: 'skipped', findings: [], errorReason: 'no files written by implementer' };
  }

  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';
  let result;
  try {
    result = await delegateWithEscalation(
      {
        prompt: buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog),
        agentType: reviewerSlot,
        briefQualityPolicy: 'off',
        timeoutMs: 120_000,
      },
      [reviewerProvider],
      { explicitlyPinned: true },
    );
  } catch (err) {
    return { status: 'error', findings: [], errorReason: `review agent threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.status !== 'ok') {
    return { status: 'error', findings: [], errorReason: `review agent returned status: ${result.status}` };
  }

  let report = parseStructuredReport(result.output);
  if (!report.summary) {
    try {
      const retryResult = await delegateWithEscalation(
        {
          prompt: buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog) +
            '\n\nIMPORTANT: Your response MUST begin with a "## Summary" section containing either "approved" or "changes_required". Follow this exact format.',
          agentType: reviewerSlot,
          briefQualityPolicy: 'off',
          timeoutMs: 120_000,
        },
        [reviewerProvider],
        { explicitlyPinned: true },
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
