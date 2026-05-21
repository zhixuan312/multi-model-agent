import type { HeadlineTemplate } from './headline-composer.js';
import { isNotApplicable } from './not-applicable.js';
import { countHighOrCritical, parseNarrativeFindings } from './severity.js';

/**
 * Shared headline for read routes whose terminal headline is
 * `[status] <route> <path>: N findings (M <countLabel>)`. Findings come from
 * the annotator-built report when present, else parseNarrativeFindings of the
 * worker output. audit + debug use countLabel 'high'; review uses 'blocking'.
 *
 * Replaces the per-tool audit/review/debug headline templates, which were
 * byte-identical apart from the route name and the count word.
 */
export function makeFindingsHeadlineTemplate(
  routeName: string,
  countLabel: 'high' | 'blocking',
): HeadlineTemplate {
  return {
    compose({ report, status, runResult, task }) {
      const r = report as { findings?: unknown; filePath?: unknown; documentPath?: unknown } | null | undefined;
      const reportInapplicable = !r || isNotApplicable(r);
      const reportFindings = !reportInapplicable && Array.isArray(r?.findings)
        ? (r!.findings as Array<{ severity?: unknown }>)
        : [];
      let findings: Array<{ severity?: unknown }> = reportFindings.length > 0 ? reportFindings : [];
      if (findings.length === 0 && typeof runResult?.output === 'string') {
        const narrative = parseNarrativeFindings(runResult.output);
        if (narrative.length > 0) findings = narrative;
      }
      const path =
        (!reportInapplicable && typeof r?.documentPath === 'string' ? (r!.documentPath as string) : '')
        || (!reportInapplicable && typeof r?.filePath === 'string' ? (r!.filePath as string) : '')
        || (task as { filePaths?: string[] } | undefined)?.filePaths?.[0]
        || '';
      if (findings.length === 0 && !path) {
        return `[${status}] ${routeName} completed`;
      }
      const blocking = countHighOrCritical(findings);
      return path
        ? `[${status}] ${routeName} ${path}: ${findings.length} findings (${blocking} ${countLabel})`
        : `[${status}] ${routeName}: ${findings.length} findings (${blocking} ${countLabel})`;
    },
  };
}
