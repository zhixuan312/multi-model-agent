import type { ReportSchema } from '../structured-report-parser.js';

export interface ExecutePlanReport {
  summary: string;
  filesChanged: string[];
  taskOutcomes: Array<{ taskIndex: number; status: string }>;
}

export const executePlanReportSchema: ReportSchema<ExecutePlanReport> = {
  parse(text: string) {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('execute_plan report missing JSON block');
    return JSON.parse(m[1]);
  },
};
