import { describe, it, expect } from 'bun:test';
import { makeFindingsHeadlineTemplate } from '../../packages/core/src/reporting/findings-headline.js';

describe('makeFindingsHeadlineTemplate', () => {
  it('audit uses "high" and names the path', () => {
    const t = makeFindingsHeadlineTemplate('audit', 'high');
    const out = t.compose({
      taskBrief: 'audit', status: 'ok', report: null,
      runResult: { output: '## Finding 1: x\n- Severity: high\n' } as any,
      task: { filePaths: ['a.ts'] } as any,
    });
    expect(out).toBe('[ok] audit a.ts: 1 findings (1 high)');
  });

  it('review uses "blocking"', () => {
    const t = makeFindingsHeadlineTemplate('review', 'blocking');
    const out = t.compose({
      taskBrief: 'review', status: 'ok', report: null,
      runResult: { output: '## Finding 1: x\n- Severity: critical\n' } as any,
      task: { filePaths: ['a.ts'] } as any,
    });
    expect(out).toBe('[ok] review a.ts: 1 findings (1 blocking)');
  });

  it('debug uses "high" without a path', () => {
    const t = makeFindingsHeadlineTemplate('debug', 'high');
    const out = t.compose({
      taskBrief: 'debug', status: 'ok', report: null,
      runResult: { output: '## Finding 1: x\n- Severity: high\n' } as any,
    });
    expect(out).toBe('[ok] debug: 1 findings (1 high)');
  });

  it('collapses to completed with no findings and no path', () => {
    const t = makeFindingsHeadlineTemplate('audit', 'high');
    expect(t.compose({ taskBrief: 'audit', status: 'ok', report: null })).toBe('[ok] audit completed');
  });
});
