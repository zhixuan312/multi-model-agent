import type { ReportSchema } from '../structured-report-parser.js';

/**
 * Shared fallback report slot for routes whose canonical structured report is
 * built by the annotator (audit/review/debug) or whose envelope report is
 * overwritten in postProcess (retry). The slot is required by ToolConfig but
 * never produces a report itself — it throws so task-executor falls through to
 * parseStructuredReport, matching debug's prior inline behavior.
 */
export const noStructuredReportSchema: ReportSchema<never> = {
  parse(): never {
    throw new Error('no structured report emitted by this route');
  },
};
