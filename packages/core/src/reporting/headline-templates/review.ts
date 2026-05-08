import type { HeadlineTemplate } from '../headline-composer.js';
import type { ReviewReport } from '../report-parser-slots/review-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { countHighOrCritical } from '../severity.js';

export const reviewHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, taskBrief, runResult, task }) {
    const r = report as Partial<ReviewReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // 4.0.3+ Gap 2 fix: prefer report.findings (structured), fall back
    // to runResult.annotatedFindings (narrative-path canonical source).
    const reportFindings = !reportInapplicable && Array.isArray(r?.findings) ? r!.findings : [];
    const annotated = runResult?.annotatedFindings ?? [];
    const findings = reportFindings.length > 0 ? reportFindings : annotated;

    if (findings.length === 0) {
      return `[${status}] review: ${taskBrief}`;
    }

    const blocking = countHighOrCritical(findings as Array<{ severity?: unknown }>);
    const path =
      (!reportInapplicable && typeof r?.filePath === 'string' ? r!.filePath : '')
      || (task as { filePaths?: string[] } | undefined)?.filePaths?.[0]
      || '';

    return `[${status}] review ${path}: ${findings.length} findings (${blocking} blocking)`;
  },
};
