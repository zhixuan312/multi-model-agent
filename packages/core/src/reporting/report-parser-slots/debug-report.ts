import type { ReportSchema } from '../structured-report-parser.js';

export interface DebugReport {
  rootCause: string;
  hypothesesConsidered: string[];
  evidenceQuotes: string[];
  recommendedFix?: string;
}

export const debugReportSchema: ReportSchema<DebugReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('debug report missing JSON block');
    return JSON.parse(m[1]);
  },
};
