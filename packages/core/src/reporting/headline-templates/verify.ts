import type { HeadlineTemplate } from '../headline-composer.js';
import { type VerifyReport, parseVerifyResults } from '../report-parser-slots/verify-report.js';
import { isNotApplicable } from '../not-applicable.js';

export const verifyHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult, task }) {
    const r = report as Partial<VerifyReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // Source priority (parallel to audit + review):
    //   1. report.results (structured path; the primary parser now handles
    //      both JSON and narrative).
    //   2. parseVerifyResults(runResult.output) (defensive fallback when the
    //      structured parser ran a non-verify schema and stripped the
    //      narrative — same Gap-A pattern surfaced on review #2).
    let results: Array<{ pass: boolean }> =
      !reportInapplicable && Array.isArray(r?.results) ? r!.results : [];
    if (results.length === 0 && typeof runResult?.output === 'string') {
      const narrative = parseVerifyResults(runResult.output);
      if (narrative.length > 0) results = narrative;
    }

    const path =
      (task as { filePaths?: string[] } | undefined)?.filePaths?.[0] || '';

    if (results.length === 0 && !path) {
      return `[${status}] verify completed`;
    }

    const passed = results.filter((x) => x?.pass).length;
    return path
      ? `[${status}] verify ${path}: ${passed}/${results.length} pass`
      : `[${status}] verify: ${passed}/${results.length} pass`;
  },
};
