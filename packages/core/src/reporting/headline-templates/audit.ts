import type { HeadlineTemplate } from '../headline-composer.js';
import type { AuditReport } from '../report-parser-slots/audit-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { countHighOrCritical, parseNarrativeFindings } from '../severity.js';

export const auditHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult, task }) {
    const r = report as Partial<AuditReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // Source priority for findings (v4.5.2+):
    //   1. Structured report's `findings` (rare — only when the worker
    //      emitted proper JSON matching the audit reportSchema).
    //   2. parseNarrativeFindings(runResult.output) — recovers findings
    //      directly from the implementer's `## Finding N:` output when
    //      no structured report was emitted. This is the load-bearing
    //      path for read-route audits (their workers emit narrative,
    //      not structured JSON).
    const reportFindings = !reportInapplicable && Array.isArray(r?.findings) ? r!.findings : [];
    let findings: Array<{ severity?: unknown }> =
      reportFindings.length > 0
        ? (reportFindings as Array<{ severity?: unknown }>)
        : [];
    if (findings.length === 0 && typeof runResult?.output === 'string') {
      const narrative = parseNarrativeFindings(runResult.output);
      if (narrative.length > 0) findings = narrative;
    }

    if (findings.length === 0 && reportInapplicable) {
      return `[${status}] audit completed`;
    }

    const high = countHighOrCritical(findings);

    // Document path fallback: when narrative-parse is the active source,
    // the structured report's documentPath is absent; pull from the task's
    // filePaths instead.
    const path =
      (!reportInapplicable && typeof r?.documentPath === 'string' ? r!.documentPath : '')
      || (task as { filePaths?: string[] } | undefined)?.filePaths?.[0]
      || '';

    return `[${status}] audit ${path}: ${findings.length} findings (${high} high)`;
  },
};
