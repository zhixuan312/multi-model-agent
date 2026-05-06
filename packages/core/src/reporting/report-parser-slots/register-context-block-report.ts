import type { ReportSchema } from '../structured-report-parser.js';

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
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (!m) throw new Error('register-context-block report missing JSON block');
    return JSON.parse(m[1]);
  },
};
