import type { ReportSchema } from '../structured-report-parser.js';

export interface InvestigateReport {
  question: string;
  answer: string;
  citations: Array<{ source: string; quote: string }>;
  confidence?: 'low' | 'medium' | 'high';
  incompleteReason?: string;
}

export const investigateReportSchema: ReportSchema<InvestigateReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('investigate report missing JSON block');
    return JSON.parse(m[1]);
  },
};
