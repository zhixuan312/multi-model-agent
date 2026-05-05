import type { HeadlineTemplate } from '../headline-composer.js';
import type { DebugReport } from '../report-parser-slots/debug-report.js';

export const debugHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    const r = report as DebugReport;
    return `[${status}] debug: ${r.rootCause}`;
  },
};
