import type { HeadlineTemplate } from '../headline-composer.js';
import { isNotApplicable } from '../not-applicable.js';

export const exploreHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    if (!report || isNotApplicable(report)) return `[${status}] explore: no structured report available`;
    const r = report as { topic?: string; internalFindings?: unknown[]; externalFindings?: unknown[] };
    const topic = r.topic ?? '';
    const internal = Array.isArray(r.internalFindings) ? r.internalFindings.length : 0;
    const external = Array.isArray(r.externalFindings) ? r.externalFindings.length : 0;
    return `[${status}] explore '${topic}': ${internal}/${external} (int/ext)`;
  },
};
