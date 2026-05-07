import type { HeadlineTemplate } from '../headline-composer.js';
import type { ReviewReport } from '../report-parser-slots/review-report.js';
import { isNotApplicable } from '../not-applicable.js';

export const reviewHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, taskBrief }) {
    if (isNotApplicable(report)) {
      return `[${status}] review: ${taskBrief}`;
    }
    const r = report as ReviewReport;
    if (!r?.findings) {
      return `[${status}] review: ${taskBrief}`;
    }
    const blocking = r.findings.filter(f => f.severity === 'high').length;
    return `[${status}] review ${r.filePath}: ${r.findings.length} findings (${blocking} blocking)`;
  },
};
