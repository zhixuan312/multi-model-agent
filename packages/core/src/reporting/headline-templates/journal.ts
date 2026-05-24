import type { HeadlineTemplate } from '../headline-composer.js';
import type { JournalStructuredReport } from '../report-parser-slots/journal-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { firstSentenceOrTruncate } from '../headline-text.js';

export const journalHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult }) {
    const r = report as Partial<JournalStructuredReport> | null | undefined;
    const inapplicable = !r || isNotApplicable(r);
    const reportFiles = !inapplicable && Array.isArray(r?.filesChanged) ? r!.filesChanged : [];
    const runFiles = Array.isArray(runResult?.filesWritten) ? runResult!.filesWritten : [];
    const fileCount = reportFiles.length > 0 ? reportFiles.length : runFiles.length;
    const rawSummary = (!inapplicable && typeof r?.summary === 'string' && r.summary.length > 0)
      ? r.summary : (typeof runResult?.output === 'string' ? runResult.output : '');
    const summary = firstSentenceOrTruncate(rawSummary);
    const clause = summary.length > 0 ? ` ${summary}` : '';
    return `[${status}] journal:${clause} (${fileCount} file${fileCount === 1 ? '' : 's'})`;
  },
};
