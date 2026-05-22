import type { ReportSchema } from '../structured-report-parser.js';
import { extractFencedJson } from '../extract-fenced-json.js';

export interface DebugReport {
  rootCause: string;
  hypothesesConsidered: string[];
  evidenceQuotes: string[];
  recommendedFix?: string;
}

export const debugReportSchema: ReportSchema<DebugReport> = {
  parse(text: string) {
    return extractFencedJson(text, 'debug') as DebugReport;
  },
};
