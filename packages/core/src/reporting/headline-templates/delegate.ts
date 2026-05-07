import type { HeadlineTemplate } from '../headline-composer.js';
import type { DelegateStructuredReport } from '../report-parser-slots/delegate-report.js';
import { isNotApplicable } from '../not-applicable.js';

export const delegateHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    if (!report || isNotApplicable(report)) return `[${status}] no structured report available`;
    const r = report as DelegateStructuredReport;
    const files = Array.isArray(r.filesChanged) ? r.filesChanged : [];
    const summary = typeof r.summary === 'string' ? r.summary : '';
    return `[${status}] ${summary} (${files.length} file${files.length === 1 ? '' : 's'})`;
  },
};
