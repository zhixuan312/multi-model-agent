import type { HeadlineTemplate } from '../headline-composer.js';

/**
 * Compose a terminal headline for debug. Matches the composeTerminalHeadline
 * format that the legacy executor produced: "debug: 1/1 tasks complete".
 * Debug always dispatches exactly 1 task.
 */
export const debugHeadlineTemplate: HeadlineTemplate = {
  compose({ report }) {
    const r = report as Record<string, unknown> | undefined;
    if (r && typeof r.rootCause === 'string' && r.rootCause.length > 0) {
      return `debug: root cause — ${r.rootCause}`;
    }
    return 'debug: 1/1 tasks complete';
  },
};
