import type { HeadlineTemplate } from '../headline-composer.js';
import { firstSentenceOrTruncate } from '../headline-text.js';

interface TaskOutcome {
  taskIndex: number;
  status: string;
}

interface ExecutePlanReportLike {
  summary?: string;
  taskOutcomes?: TaskOutcome[];
}

export const executePlanHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult }) {
    const r = report as ExecutePlanReportLike | undefined;
    // Tool sweep #7 (execute-plan): use the dash-cased route name
    // `execute-plan` to match the HTTP path + envelope shapes (the
    // pre-fix `execute_plan` underscore was the only tool diverging
    // from kebab-case in operator-facing output) and ALWAYS include
    // the [<status>] prefix for parity with audit/review/verify/debug/
    // delegate.
    if (r?.taskOutcomes && Array.isArray(r.taskOutcomes) && r.taskOutcomes.length > 0) {
      const completed = r.taskOutcomes.filter(
        (t: TaskOutcome) => t.status === 'completed' || t.status === 'success',
      ).length;
      return `[${status}] execute-plan: ${completed}/${r.taskOutcomes.length} tasks complete`;
    }
    // Tool sweep #7: fall back to runResult.output when report has no
    // summary. Mirrors the delegate fix — operator gets a meaningful
    // reason on no-op outcomes instead of a bare `[<status>] execute-plan`.
    const fallbackSrc = (r?.summary && typeof r.summary === 'string' && r.summary.length > 0)
      ? r.summary
      : (typeof runResult?.output === 'string' ? runResult.output : '');
    const summary = firstSentenceOrTruncate(fallbackSrc);
    const summaryClause = summary.length > 0 ? ` ${summary}` : '';
    return `[${status}] execute-plan:${summaryClause}`;
  },
};
