import type { ReportSchema } from '../structured-report-parser.js';

export interface DelegateStructuredReport {
  summary: string;
  filesChanged: string[];
  notes?: string;
}

export const delegateReportSchema: ReportSchema<DelegateStructuredReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('delegate report missing JSON block');
    const parsed = JSON.parse(m[1]);
    return {
      summary: parsed.summary ?? '',
      filesChanged: parsed.filesChanged ?? [],
      notes: parsed.notes,
    };
  },
};
