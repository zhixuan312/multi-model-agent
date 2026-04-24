import type { ParsedStructuredReport } from '../reporting/structured-report.js';

export function extractWorkerStatus(
  report: ParsedStructuredReport | undefined,
): 'done' | 'done_with_concerns' | 'needs_context' | 'blocked' {
  if (!report || !report.summary) return 'done';
  const s = report.summary.toLowerCase();
  if (s.includes('needs_context')) return 'needs_context';
  if (s.includes('blocked')) return 'blocked';
  if (s.includes('done_with_concerns') || s.includes('concerns')) return 'done_with_concerns';
  return 'done';
}
