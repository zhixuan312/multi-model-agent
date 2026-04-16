import type { Provider } from '../types.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { buildQualityReviewPrompt } from './reviewer-prompt.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';

export interface QualityReviewResult {
  status: 'approved' | 'changes_required' | 'skipped' | 'error';
  report?: ParsedStructuredReport;
  findings: string[];
}

export async function runQualityReview(
  reviewerProvider: Provider,
  packet: { normalizedPrompt: string; scope: string[]; doneCondition: string },
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
  filesWritten: string[],
): Promise<QualityReviewResult> {
  if (filesWritten.length === 0) {
    return { status: 'skipped', findings: [] };
  }

  let result;
  try {
    const reviewerSlot: 'standard' | 'complex' =
      reviewerProvider.name === 'standard' ? 'standard' : 'complex';
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
  } catch {
    return { status: 'error', findings: [] };
  }

  if (result.status !== 'ok') {
    return { status: 'error', findings: [] };
  }

  const report = parseStructuredReport(result.output);
  if (!report.summary) {
    return { status: 'error', findings: [] };
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
