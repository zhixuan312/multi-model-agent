import type { ReportSchema } from '../structured-report-parser.js';

export interface AuditReport {
  documentPath: string;
  findings: Array<{
    severity: 'low' | 'medium' | 'high';
    category: string;
    message: string;
    evidenceQuote: string;
    annotatorConfidence: number;
  }>;
}

export const auditReportSchema: ReportSchema<AuditReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('audit report missing JSON block');
    return JSON.parse(m[1]);
  },
};
