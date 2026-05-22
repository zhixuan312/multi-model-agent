import type { ReportSchema } from '../structured-report-parser.js';
import { extractFencedJson } from '../extract-fenced-json.js';

export interface ExecutePlanReport {
  summary: string;
  filesChanged: string[];
  taskOutcomes: Array<{ taskIndex: number; status: string }>;
}

export const executePlanReportSchema: ReportSchema<ExecutePlanReport> = {
  parse(text: string) {
    return extractFencedJson(text, 'execute-plan') as ExecutePlanReport;
  },
};
