import type { HeadlineTemplate } from '../headline-composer.js';
import type { DelegateStructuredReport } from '../slots/delegate-report.js';

export const delegateHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    if (!report) return `[${status}] no structured report available`;
    const r = report as DelegateStructuredReport;
    return `[${status}] ${r.summary} (${r.filesChanged.length} file${r.filesChanged.length === 1 ? '' : 's'})`;
  },
};
