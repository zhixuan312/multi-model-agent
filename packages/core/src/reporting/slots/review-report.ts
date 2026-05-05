import type { ReportSchema } from '../structured-report-parser.js';

export interface ReviewReport {
  filePath: string;
  findings: Array<{
    severity: 'low' | 'medium' | 'high';
    category: string;
    message: string;
    lineNumber?: number;
    evidenceQuote: string;
    annotatorConfidence: number;
  }>;
}

export const reviewReportSchema: ReportSchema<ReviewReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('review report missing JSON block');
    return JSON.parse(m[1]);
  },
};
