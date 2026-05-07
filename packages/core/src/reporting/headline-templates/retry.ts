import type { HeadlineTemplate } from '../headline-composer.js';

export const retryHeadlineTemplate: HeadlineTemplate = {
  compose() {
    // The retry envelope's headline is overwritten by postProcessEnvelope to
    // reflect total/completed counts. This default keeps shape uniformity if
    // the post-process step is ever skipped.
    return 'retry';
  },
};
