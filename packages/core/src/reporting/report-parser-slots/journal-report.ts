import type { ReportSchema } from '../structured-report-parser.js';
import { extractFencedJson } from '../extract-fenced-json.js';

export interface JournalStructuredReport {
  summary: string;        // e.g. "created 0012; superseded 0009"
  filesChanged: string[];
  op?: string;            // create|refine|supersede|merge
}

export const journalReportSchema: ReportSchema<JournalStructuredReport> = {
  parse(text: string) {
    const p = extractFencedJson(text, 'journal') as Record<string, unknown>;
    return {
      summary: (p.summary as string) ?? '',
      filesChanged: (p.filesChanged as string[]) ?? [],
      op: p.op as string | undefined,
    };
  },
};
