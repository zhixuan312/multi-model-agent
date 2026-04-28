import type { ParsedStructuredReport } from '../reporting/structured-report.js';

type ReviewAggregateStatus =
  | 'approved'
  | 'changes_required'
  | 'annotated'
  | 'skipped'
  | 'error'
  | 'api_error'
  | 'network_error'
  | 'timeout';

export function aggregateResult(
  implReport: ParsedStructuredReport,
  specReport: ParsedStructuredReport | undefined,
  qualityReport: ParsedStructuredReport | undefined,
  specStatus: ReviewAggregateStatus,
  qualityStatus: ReviewAggregateStatus,
): ParsedStructuredReport {
  const prefix =
    specStatus === 'changes_required'
      ? '[Spec review exhausted] '
      : qualityStatus === 'changes_required'
        ? '[Quality review exhausted] '
        : '[Reviewed] ';

  return {
    summary: `${prefix}${implReport.summary ?? ''}`,
    filesChanged: [
      ...implReport.filesChanged,
      ...(qualityReport?.filesChanged ?? []),
    ],
    validationsRun: [
      ...implReport.validationsRun,
      ...(specReport?.validationsRun ?? []),
      ...(qualityReport?.validationsRun ?? []),
    ],
    deviationsFromBrief: [
      ...(implReport.deviationsFromBrief ?? []),
      ...(specReport?.deviationsFromBrief ?? []),
      ...(qualityReport?.deviationsFromBrief ?? []),
    ],
    unresolved: [
      ...(implReport.unresolved ?? []),
      ...(specReport?.unresolved ?? []),
      ...(qualityReport?.unresolved ?? []),
    ],
    extraSections: {
      ...(implReport.extraSections ?? {}),
      ...(specReport?.extraSections ?? {}),
      ...(qualityReport?.extraSections ?? {}),
    },
  };
}
