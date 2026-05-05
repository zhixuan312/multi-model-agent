import type { ReportSchema } from '../structured-report-parser.js';

export interface ExploreReport {
  topic: string;
  internalFindings: Array<{ source: string; summary: string }>;
  externalFindings: Array<{ url: string; title: string; summary: string }>;
  synthesis: string;
  incompleteReason?: string;
}

export const exploreReportSchema: ReportSchema<ExploreReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('explore report missing JSON block');
    return JSON.parse(m[1]);
  },
};
