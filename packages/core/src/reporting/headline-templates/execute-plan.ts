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
  compose({ report, status }) {
    const r = report as ExecutePlanReportLike | undefined;
    if (r?.taskOutcomes && Array.isArray(r.taskOutcomes) && r.taskOutcomes.length > 0) {
      const completed = r.taskOutcomes.filter(
        (t: TaskOutcome) => t.status === 'completed' || t.status === 'success',
      ).length;
      return `execute_plan: ${completed}/${r.taskOutcomes.length} tasks complete`;
    }
    if (r?.summary && typeof r.summary === 'string') {
      // Gap 12 fix (4.0.3+): trim worker's narrative summary so the
      // headline doesn't dump multi-sentence prose ending mid-thought.
      return `[${status}] execute_plan: ${firstSentenceOrTruncate(r.summary)}`;
    }
    return `[${status}] execute_plan`;
  },
};
