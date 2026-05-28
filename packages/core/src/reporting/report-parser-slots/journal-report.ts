import type { ReportSchema } from '../structured-report-parser.js';
import { extractFencedJson } from '../extract-fenced-json.js';

export interface JournalRecordedEntry { learningIndex: number; op: string; ids: string[]; }
export interface JournalFailedEntry { learningIndex: number; learning: string; reason: string; }

export interface JournalStructuredReport {
  summary: string;
  filesChanged: string[];
  recorded: JournalRecordedEntry[];
  failed: JournalFailedEntry[];
}

export const journalReportSchema: ReportSchema<JournalStructuredReport> = {
  parse(text: string) {
    const p = extractFencedJson(text, 'journal') as Record<string, unknown>;
    return {
      summary: (p.summary as string) ?? '',
      filesChanged: (p.filesChanged as string[]) ?? [],
      recorded: Array.isArray(p.recorded) ? (p.recorded as JournalRecordedEntry[]) : [],
      failed: Array.isArray(p.failed) ? (p.failed as JournalFailedEntry[]) : [],
    };
  },
};
