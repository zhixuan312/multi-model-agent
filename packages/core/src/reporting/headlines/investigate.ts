import type { HeadlineTemplate } from '../headline-composer.js';

export const investigateHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    const r = report as any;
    return `[${status}] investigate: ${r.citations.length} citation${r.citations.length === 1 ? '' : 's'}`;
  },
};
