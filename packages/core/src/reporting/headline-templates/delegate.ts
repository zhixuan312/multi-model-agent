import type { HeadlineTemplate } from '../headline-composer.js';
import type { DelegateStructuredReport } from '../report-parser-slots/delegate-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { firstSentenceOrTruncate } from '../headline-text.js';

export const delegateHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult }) {
    const r = report as Partial<DelegateStructuredReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // Gap 13 fix (4.0.3+): file count source priority is
    // `report.filesChanged` (rare — only when the worker emits proper
    // structured output) → `runResult.filesWritten` (canonical
    // runner-shell signal that always reflects reality, including
    // synthetic `shell:<cmd>` entries from Gap 11). Pre-fix, the
    // composer only read report.filesChanged and reported "(0 files)"
    // even when the worker had successfully edited files via
    // edit_file or run_shell.
    const reportFiles = !reportInapplicable && Array.isArray(r?.filesChanged) ? r!.filesChanged : [];
    const runFiles = Array.isArray(runResult?.filesWritten) ? runResult!.filesWritten : [];
    const fileCount = reportFiles.length > 0 ? reportFiles.length : runFiles.length;

    if (reportInapplicable && fileCount === 0) {
      return `[${status}] delegate: no structured report available`;
    }

    // Gap 12 fix (4.0.3+): trim worker's narrative `summary` to first
    // sentence (or 80-char truncate). Pre-fix, the entire summary —
    // sometimes multi-sentence prose ending mid-thought — was inlined
    // into the headline.
    //
    // Tool sweep #6 follow-up: when the structured report carries no
    // summary, fall back to the worker's `output` text (also trimmed to
    // first sentence) so the headline is informative even on no-op /
    // 0-file outcomes. Pre-fix, those collapsed to `[incomplete] (0
    // files)` with NO clue why.
    const rawSummary = (!reportInapplicable && typeof r?.summary === 'string' && r.summary.length > 0)
      ? r.summary
      : (typeof runResult?.output === 'string' ? runResult.output : '');
    const summary = firstSentenceOrTruncate(rawSummary);

    const summaryClause = summary.length > 0 ? ` ${summary}` : '';
    // Tool sweep #6 follow-up: prefix with `delegate:` for parity with
    // audit / review / verify / debug / investigate headlines so the
    // operator can tell the route at a glance.
    return `[${status}] delegate:${summaryClause} (${fileCount} file${fileCount === 1 ? '' : 's'})`;
  },
};
