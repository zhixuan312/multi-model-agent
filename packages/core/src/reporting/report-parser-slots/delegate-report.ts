import type { ReportSchema } from '../structured-report-parser.js';
import { extractFencedJson } from '../extract-fenced-json.js';

export interface DelegateStructuredReport {
  summary: string;
  filesChanged: string[];
  notes?: string;
}

export const delegateReportSchema: ReportSchema<DelegateStructuredReport> = {
  parse(text: string) {
    const parsed = extractFencedJson(text, 'delegate') as Record<string, unknown>;
    return {
      summary: (parsed.summary as string) ?? '',
      filesChanged: (parsed.filesChanged as string[]) ?? [],
      notes: parsed.notes as string | undefined,
    };
  },
};
