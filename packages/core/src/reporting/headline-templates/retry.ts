import type { HeadlineTemplate } from '../headline-composer.js';

export const retryHeadlineTemplate: HeadlineTemplate = {
  compose({ status }) {
    return `[${status}] retry`;
  },
};
