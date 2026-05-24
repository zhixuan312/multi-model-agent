import type { HeadlineTemplate } from '../headline-composer.js';
import { firstSentenceOrTruncate } from '../headline-text.js';

export const journalRecallHeadlineTemplate: HeadlineTemplate = {
  compose({ status, runResult }) {
    const summary = firstSentenceOrTruncate(typeof runResult?.output === 'string' ? runResult.output : '');
    const clause = summary.length > 0 ? ` ${summary}` : '';
    return `[${status}] journal-recall:${clause}`;
  },
};
