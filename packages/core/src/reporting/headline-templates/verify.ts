import type { HeadlineTemplate } from '../headline-composer.js';
import type { VerifyReport } from '../report-parser-slots/verify-report.js';

export const verifyHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    const r = report as VerifyReport;
    const passed = r.results.filter((x) => x.pass).length;
    return `[${status}] verify: ${passed}/${r.results.length} pass`;
  },
};
