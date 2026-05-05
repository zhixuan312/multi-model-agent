import type { HeadlineTemplate } from '../headline-composer.js';

export const exploreHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    const r = report as any;
    return `[${status}] explore '${r.topic}': ${r.internalFindings.length}/${r.externalFindings.length} (int/ext)`;
  },
};
