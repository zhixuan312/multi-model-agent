import type { ReportSchema } from '../structured-report-parser.js';
import { extractFencedJson } from '../extract-fenced-json.js';

// register-context-block is a synchronous state operation — no LLM
// emits a structured report for it. The slot exists so the framework
// can resolve a parser per route uniformly.
export interface RegisterContextBlockReport {
  blockId: string;
  size: number;
  ttlMs?: number;
}

export const registerContextBlockReportSchema: ReportSchema<RegisterContextBlockReport> = {
  parse(text: string) {
    return extractFencedJson(text, 'register-context-block') as RegisterContextBlockReport;
  },
};
