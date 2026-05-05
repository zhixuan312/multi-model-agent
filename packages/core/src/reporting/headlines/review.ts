import type { HeadlineTemplate } from '../headline-composer.js';
import type { ReviewReport } from '../slots/review-report.js';

export const reviewHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    const r = report as ReviewReport;
    const blocking = r.findings.filter(f => f.severity === 'high').length;
    return `[${status}] review ${r.filePath}: ${r.findings.length} findings (${blocking} blocking)`;
  },
};
