import type { ParsedStructuredReport } from '../reporting/structured-report.js';

export function aggregateResult(
  implReport: ParsedStructuredReport,
  specReport: ParsedStructuredReport | undefined,
  qualityReport: ParsedStructuredReport | undefined,
  specStatus: 'approved' | 'changes_required' | 'not_run',
  qualityStatus: 'approved' | 'changes_required' | 'not_run',
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
    normalizationDecisions: implReport.normalizationDecisions,
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
  };
}