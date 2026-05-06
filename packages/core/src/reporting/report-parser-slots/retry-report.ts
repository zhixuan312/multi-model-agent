import type { ReportSchema } from '../structured-report-parser.js';

// retry replays existing tasks; its terminal envelope inherits the
// report from the underlying tool. This passthrough schema records
// the absence of a retry-specific report shape.
export interface RetryReport {
  retriedTaskIndex: number;
  originalTaskIndex: number;
  inheritedToolCategory: string;
}

export const retryReportSchema: ReportSchema<RetryReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('retry report missing JSON block');
    return JSON.parse(m[1]);
  },
};
