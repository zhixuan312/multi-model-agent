import type { HeadlineTemplate } from '../headline-composer.js';
import type { AuditReport } from '../report-parser-slots/audit-report.js';
import { isNotApplicable } from '../not-applicable.js';
import { countHighOrCritical } from '../severity.js';

export const auditHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult, task }) {
    const r = report as Partial<AuditReport> | null | undefined;
    const reportInapplicable = !r || isNotApplicable(r);

    // Source priority for findings (4.0.3+ Gap 2 fix):
    //   1. Structured report's `findings` (rare — only when the worker
    //      emitted proper JSON matching the audit reportSchema).
    //   2. runResult.annotatedFindings (canonical narrative-path source,
    //      populated by the quality-chain handler when verdict='annotated').
    // Pre-fix the composer only read (1) — when the worker emitted
    // narrative `## Finding N:` blocks, the structuredReport fallback
    // had no `findings` field, so the headline reported "0 findings"
    // even when the annotator returned dozens.
    const reportFindings = !reportInapplicable && Array.isArray(r?.findings) ? r!.findings : [];
    const annotated = runResult?.annotatedFindings ?? [];
    const findings = reportFindings.length > 0 ? reportFindings : annotated;

    if (findings.length === 0 && reportInapplicable) {
      return `[${status}] audit completed`;
    }

    const high = countHighOrCritical(findings as Array<{ severity?: unknown }>);

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
