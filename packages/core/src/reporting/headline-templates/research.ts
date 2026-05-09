// packages/core/src/reporting/headline-templates/research.ts
import type { HeadlineTemplate } from '../headline-composer.js';
import type { ResearchReport } from '../report-parser-slots/research-report.js';

const REASON_TEXT: Record<string, string> = {
  cost_cap: 'cost cap reached',
  timeout: 'timed out',
  turn_cap: 'turn cap reached',
};

export const researchHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status, runResult }) {
    const r = report as Partial<ResearchReport> | null | undefined;
    const findings = Array.isArray(r?.findings) ? r!.findings : [];
    const sources = Array.isArray(r?.sourcesUsed) ? r!.sourcesUsed : [];

    if (status === 'incomplete') {
      const reasonKey = (runResult as { incompleteReason?: string } | undefined)?.incompleteReason ?? '';
      const reason = REASON_TEXT[reasonKey] ?? reasonKey ?? 'incomplete';
      return `[incomplete] research: ${reason}`;
    }
    if (status === 'error') {
      const msg = (runResult as { error?: string } | undefined)?.error ?? 'runner crash';
      return `[error] research: ${msg}`;
    }
    return `[ok] research: ${sources.length} sources, ${findings.length} findings`;
  },
};
