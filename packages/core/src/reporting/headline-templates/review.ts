import type { HeadlineTemplate } from '../headline-composer.js';
import type { ReviewReport } from '../report-parser-slots/review-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { countHighOrCritical, parseNarrativeFindings } from '../severity.js';

export const reviewHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, taskBrief, runResult, task }) {
    const r = report as Partial<ReviewReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // Source priority (4.0.3+, parallel to audit):
    //   1. report.findings (structured)
    //   2. runResult.annotatedFindings (annotator success path)
    //   3. parseNarrativeFindings(runResult.output) (annotator error
    //      fallback — recover from implementer's `## Finding N:` blocks)
    const reportFindings = !reportInapplicable && Array.isArray(r?.findings) ? r!.findings : [];
    const annotated = runResult?.annotatedFindings ?? [];
    let findings: Array<{ severity?: unknown }> =
      reportFindings.length > 0
        ? (reportFindings as Array<{ severity?: unknown }>)
        : (annotated as Array<{ severity?: unknown }>);
    if (findings.length === 0 && typeof runResult?.output === 'string') {
      const narrative = parseNarrativeFindings(runResult.output);
      if (narrative.length > 0) findings = narrative;
    }

    if (findings.length === 0) {
      return `[${status}] review: ${taskBrief}`;
    }

    const blocking = countHighOrCritical(findings);
    const path =
      (!reportInapplicable && typeof r?.filePath === 'string' ? r!.filePath : '')
      || (task as { filePaths?: string[] } | undefined)?.filePaths?.[0]
      || '';

    return `[${status}] review ${path}: ${findings.length} findings (${blocking} blocking)`;
  },
};
