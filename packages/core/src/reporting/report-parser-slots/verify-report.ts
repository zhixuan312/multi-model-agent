import type { ReportSchema } from '../structured-report-parser.js';

export interface VerifyReport {
  results: Array<{ item: string; pass: boolean; evidence: string }>;
}

export const verifyReportSchema: ReportSchema<VerifyReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('verify report missing JSON block');
    return JSON.parse(m[1]);
  },
};
