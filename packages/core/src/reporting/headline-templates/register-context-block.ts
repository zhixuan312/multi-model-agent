import type { HeadlineTemplate } from '../headline-composer.js';

export const registerContextBlockHeadlineTemplate: HeadlineTemplate = {
  compose({ status }) {
    return `[${status}] register-context-block`;
  },
};
