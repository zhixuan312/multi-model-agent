import type { HeadlineTemplate } from '../headline-composer.js';

export const executePlanHeadlineTemplate: HeadlineTemplate = {
  compose({ report, status }) {
    return `[${status}] execute_plan: ${(report as any).summary}`;
  },
};
