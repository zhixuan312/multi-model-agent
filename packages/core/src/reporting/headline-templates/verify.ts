import type { HeadlineTemplate } from '../headline-composer.js';
import type { VerifyReport } from '../report-parser-slots/verify-report.js';
import { isNotApplicable } from '../not-applicable.js';

export const verifyHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    if (!report || isNotApplicable(report)) return `[${status}] verify: no structured report available`;
    const r = report as VerifyReport;
    const items = Array.isArray(r.results) ? r.results : [];
    const passed = items.filter((x) => x?.pass).length;
    return `[${status}] verify: ${passed}/${items.length} pass`;
  },
};
