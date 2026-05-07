import type { HeadlineTemplate } from '../headline-composer.js';
import type { AuditReport } from '../report-parser-slots/audit-report.js';
import { isNotApplicable } from '../not-applicable.js';

export const auditHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    if (isNotApplicable(report)) return `[${status}] audit completed`;
    const r = report as AuditReport;
    const high = r.findings.filter(f => f.severity === 'high').length;
    return `[${status}] audit ${r.documentPath}: ${r.findings.length} findings (${high} high)`;
  },
};
