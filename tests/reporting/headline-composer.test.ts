import { describe, it, expect } from 'bun:test';
import { HeadlineComposer } from '../../packages/core/src/reporting/headline-composer.js';

describe('HeadlineComposer framework', () => {
  it('delegates to template', () => {
    const c = new HeadlineComposer({ compose: ({ status }) => `status=${status}` });
    expect(c.compose({ taskBrief: 'b', report: {}, status: 'ok' })).toBe('status=ok');
  });
});
