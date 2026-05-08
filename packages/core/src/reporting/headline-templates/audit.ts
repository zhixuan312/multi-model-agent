import type { HeadlineTemplate } from '../headline-composer.js';
import type { AuditReport } from '../report-parser-slots/audit-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { countHighOrCritical, parseNarrativeFindings } from '../severity.js';

export const auditHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult, task }) {
    const r = report as Partial<AuditReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // Source priority for findings (4.0.3+):
    //   1. Structured report's `findings` (rare — only when the worker
    //      emitted proper JSON matching the audit reportSchema).
    //   2. runResult.annotatedFindings (canonical narrative-path source
    //      populated by the quality-chain handler when verdict='annotated').
    //   3. NEW: parseNarrativeFindings(runResult.output) — recovers
    //      findings directly from the implementer's `## Finding N:`
    //      output when the annotator errored (parse failure, exhaustion).
    //      Without this third fallback, audits where the annotator
    //      failed report `0 findings (0 high)` even though the
    //      implementer's narrative carried valid findings.
    const reportFindings = !reportInapplicable && Array.isArray(r?.findings) ? r!.findings : [];
    const annotated = runResult?.annotatedFindings ?? [];
    let findings: Array<{ severity?: unknown }> =
      reportFindings.length > 0
        ? (reportFindings as Array<{ severity?: unknown }>)
        : (annotated as Array<{ severity?: unknown }>);
    if (findings.length === 0 && typeof runResult?.output === 'string') {
      const narrative = parseNarrativeFindings(runResult.output);
      if (narrative.length > 0) findings = narrative;
    }

    if (findings.length === 0 && reportInapplicable) {
      return `[${status}] audit completed`;
    }

    const high = countHighOrCritical(findings);

    // Document path fallback (per round-2 audit F3): when we fall back
    // to annotatedFindings, the structured report's documentPath is
    // absent. Pull from the task's filePaths instead.
    const path =
      (!reportInapplicable && typeof r?.documentPath === 'string' ? r!.documentPath : '')
      || (task as { filePaths?: string[] } | undefined)?.filePaths?.[0]
      || '';

    return `[${status}] audit ${path}: ${findings.length} findings (${high} high)`;
  },
};
