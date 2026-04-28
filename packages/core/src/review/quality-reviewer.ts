import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildQualityReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import type { SkippedReviewResult } from './skipped-result.js';

export interface QualityReviewResult {
  status: 'approved' | 'changes_required' | 'error' | 'api_error' | 'network_error' | 'timeout';
  report?: ParsedStructuredReport;
  findings: string[];
  errorReason?: string;
  reason?: string;
}

export type QualityReviewOrSkipped = QualityReviewResult | SkippedReviewResult;
export type LegacyQualityReviewResult = QualityReviewOrSkipped | { status: 'skipped'; report?: ParsedStructuredReport; findings: string[]; errorReason?: string };

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
): Promise<LegacyQualityReviewResult> {
  if (filesWritten.length === 0) {
    return { status: 'skipped', findings: [], errorReason: 'no files written by implementer' };
  }

  const corePrompt = qualityReviewPromptBuilder && workerOutput !== undefined
    ? qualityReviewPromptBuilder({ workerOutput, brief: packet.prompt })
    : buildQualityReviewPrompt(packet, implReport, fileContents, toolCallLog);
  const prompt = (evidenceBlock ? `${evidenceBlock}\n\n` : '') + corePrompt;
  const reviewerSlot: 'standard' | 'complex' =
    reviewerProvider.name === 'standard' ? 'standard' : 'complex';
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
          prompt: prompt +
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
